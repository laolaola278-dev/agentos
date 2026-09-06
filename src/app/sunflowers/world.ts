import * as THREE from "three";

export type PlaceId = "vase" | "house" | "lake" | "hill";
export type WorldState = {
  x: number;
  z: number;
  heading: number;
  location: string;
  discovered: PlaceId[];
  walking: boolean;
};
export const PLACES: { id: PlaceId; name: string; subtitle: string; x: number; z: number; description: string }[] = [
  { id: "vase", name: "向日葵之心", subtitle: "THE SUNFLOWER HEART", x: 0, z: -15, description: "十五朵花，从一只陶瓶里长成一整个世界。走近看，盛放与凋零都拥有自己的金黄色。" },
  { id: "house", name: "阿尔勒的黄房子", subtitle: "THE YELLOW HOUSE", x: -35, z: -35, description: "一间向阳的小屋，献给梵高在阿尔勒的日子。坐在花园旁，想象画家等待朋友到来。" },
  { id: "lake", name: "倒映的天空", subtitle: "THE REFLECTING POND", x: 34, z: -13, description: "画里的青绿，在这里化作一汪安静的水。换一个角度，收藏花朵与天空相遇的瞬间。" },
  { id: "hill", name: "金色远丘", subtitle: "THE GOLDEN OVERLOOK", x: 8, z: -67, description: "沿着小径走上山丘，回望你穿过的花海。画框之外，还有想象可以抵达的地方。" },
];

export function terrainHeight(x: number, z: number) {
  const base = Math.sin(x * 0.047) * Math.cos(z * 0.035) * 2.3 + Math.sin(z * 0.063 + x * 0.019) * 1.35;
  const mound = 8 * Math.exp(-((x - 8) ** 2 + (z + 70) ** 2) / 550);
  const vaseBlend = Math.min(1, Math.hypot(x, z + 15) / 12);
  const houseBlend = Math.min(1, Math.hypot(x + 35, z + 35) / 13);
  let h = THREE.MathUtils.lerp(0.7, base + mound, vaseBlend);
  h = THREE.MathUtils.lerp(0.9, h, houseBlend);
  const pond = Math.exp(-(((x - 34) / 12) ** 4 + ((z + 13) / 8) ** 4));
  h = THREE.MathUtils.lerp(h, -1.4, pond);
  return h;
}

function rng(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function canvasTexture(size: number, draw: (c: CanvasRenderingContext2D, random: () => number) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  draw(context, rng(size + 42));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function brushTexture(base: string, colors: string[], size = 512) {
  return canvasTexture(size, (c, random) => {
    c.fillStyle = base; c.fillRect(0, 0, size, size);
    for (let i = 0; i < 6500; i++) {
      c.globalAlpha = 0.08 + random() * 0.3;
      c.fillStyle = colors[Math.floor(random() * colors.length)];
      c.save(); c.translate(random() * size, random() * size); c.rotate(random() * 0.7 - 0.35);
      c.fillRect(0, 0, 1 + random() * 3, 3 + random() * 28); c.restore();
    }
    c.globalAlpha = 1;
  });
}

export type SunflowerWorld = ReturnType<typeof createWorld>;

export function createWorld(
  container: HTMLElement,
  onState: (state: WorldState) => void,
  onDiscovery: (id: PlaceId) => void,
  onLock: (locked: boolean) => void,
) {
  const random = rng(1888);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#d9d8ac");
  scene.fog = new THREE.FogExp2("#dbd7ab", 0.006);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.65));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.domElement.setAttribute("aria-label", "可探索的向日葵三维世界，使用 WASD 移动，拖动鼠标环顾");
  renderer.domElement.tabIndex = 0;
  container.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(62, container.clientWidth / container.clientHeight, 0.1, 420);
  const player = new THREE.Vector3(15, 0, 30);
  let yaw = 0.48;
  let pitch = 0.04;
  let verticalSpeed = 0;
  let jumpHeight = 0;
  let photoMode = false;
  let paused = false;
  let started = false;
  let disposed = false;
  let dragging = false;
  let dragX = 0;
  let dragY = 0;
  let frame = 0;
  let elapsed = 0;
  let publishTime = 0;
  let cameraFov = 62;
  let walkPhase = 0;
  let exposure = 1.18;
  const keys = new Set<string>();
  const discovered = new Set<PlaceId>();
  const clock = new THREE.Timer();
  clock.connect(document);
  const temp = new THREE.Object3D();
  const color = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  const collisions: { x: number; z: number; radius: number }[] = [{ x: 0, z: -15, radius: 4.25 }, { x: -35, z: -35, radius: 5.9 }];
  const ownedTextures = new Set<THREE.Texture>();
  const own = (texture: THREE.Texture) => { ownedTextures.add(texture); return texture; };
  const mat = (hex: string, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.93, ...extra });
  function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, shadow = true) {
    const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; scene.add(m); return m;
  }
  function box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) {
    return mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z);
  }

  scene.add(new THREE.HemisphereLight("#f8eacf", "#9a8852", 2.6));
  const sun = new THREE.DirectionalLight("#fff0c5", 3.5);
  sun.position.set(-35, 55, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -58; sun.shadow.camera.right = 58;
  sun.shadow.camera.top = 58; sun.shadow.camera.bottom = -58;
  sun.shadow.camera.far = 170;
  sun.shadow.normalBias = 0.045;
  sun.shadow.bias = -0.00015;
  sun.target.position.set(0, 0, -12);
  scene.add(sun, sun.target);

  const sky = new THREE.Mesh(new THREE.SphereGeometry(350, 40, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: "varying vec3 vPosition; void main(){vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
    fragmentShader: `varying vec3 vPosition;
      void main(){float h=normalize(vPosition).y; vec3 low=vec3(.86,.84,.66); vec3 high=vec3(.39,.61,.58);
      float t=smoothstep(-.06,.78,h); vec3 col=mix(low,high,t);
      float brush=sin(vPosition.y*.7+sin(vPosition.x*.027)*4.)*sin(vPosition.y*1.12+vPosition.z*.01);
      col+=brush*.012; gl_FragColor=vec4(col,1.);
      }`,
  }));
  scene.add(sky);
  const sunOrb = mesh(new THREE.SphereGeometry(9, 32, 16), new THREE.MeshBasicMaterial({ color: "#fff1b0", fog: false }), -105, 110, -170, false);
  sunOrb.renderOrder = -1;
  const cloudMaterial = new THREE.MeshBasicMaterial({ color: "#f9edca", transparent: true, opacity: 0.29, depthWrite: false });
  const cloudGeometry = new THREE.SphereGeometry(1, 12, 6);
  for (let i = 0; i < 44; i++) {
    const c = mesh(cloudGeometry, cloudMaterial, (random() - 0.5) * 450, 42 + random() * 65, -160 + random() * 130, false);
    c.scale.set(8 + random() * 22, 0.35 + random() * 1.2, 2 + random() * 4); c.rotation.z = random() * 0.09;
  }

  const groundTexture = own(brushTexture("#bfa15b", ["#8c8249", "#e9ca79", "#d5af59", "#aaa15c"]));
  groundTexture.wrapS = groundTexture.wrapT = THREE.RepeatWrapping; groundTexture.repeat.set(42, 42);
  const groundGeo = new THREE.PlaneGeometry(310, 310, 170, 170);
  groundGeo.rotateX(-Math.PI / 2);
  const positions = groundGeo.attributes.position;
  const colors: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), z = positions.getZ(i); positions.setY(i, terrainHeight(x, z));
    color.setHSL(0.125 + random() * 0.015, 0.27 + random() * 0.17, 0.48 + random() * 0.14);
    colors.push(color.r, color.g, color.b);
  }
  groundGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3)); groundGeo.computeVertexNormals();
  mesh(groundGeo, mat("#ffffff", { map: groundTexture, vertexColors: true }), 0, 0, 0, false);

  // Four small trails branch out from the composition's original vase.
  const trails = [
    new THREE.CatmullRomCurve3([new THREE.Vector3(20, 0, 64), new THREE.Vector3(11, 0, 32), new THREE.Vector3(-3, 0, 8), new THREE.Vector3(0, 0, -15)]),
    new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, -15), new THREE.Vector3(-19, 0, -19), new THREE.Vector3(-31, 0, -25), new THREE.Vector3(-35, 0, -29)]),
    new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, -15), new THREE.Vector3(14, 0, -4), new THREE.Vector3(24, 0, -4), new THREE.Vector3(35, 0, -3)]),
    new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, -15), new THREE.Vector3(-8, 0, -34), new THREE.Vector3(0, 0, -51), new THREE.Vector3(8, 0, -67)]),
  ];
  const pathPoints: THREE.Vector3[] = [];
  const pathTexture = own(brushTexture("#d7b570", ["#f2d49b", "#b79250", "#e7c381"]));
  pathTexture.wrapS = pathTexture.wrapT = THREE.RepeatWrapping; pathTexture.repeat.set(1, 22);
  for (const trail of trails) {
    const points = trail.getPoints(100); pathPoints.push(...points);
    const verts: number[] = [], uvs: number[] = [], indices: number[] = [];
    points.forEach((p, i) => {
      const tangent = trail.getTangent(i / 100); const width = 1.55 + Math.sin(i * 0.3) * 0.12;
      const nx = -tangent.z * width, nz = tangent.x * width;
      for (const sign of [-1, 1]) { const x = p.x + nx * sign, z = p.z + nz * sign; verts.push(x, terrainHeight(x, z) + 0.055, z); uvs.push((sign + 1) / 2, i / 100); }
      if (i < 100) { const v = i * 2; indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); }
    });
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3)); geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
    mesh(geometry, mat("#f4dca2", { map: pathTexture, side: THREE.DoubleSide }), 0, 0, 0, false);
  }
  const nearTrail = (x: number, z: number, distance: number) => pathPoints.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < distance * distance);

  // Each flower is real three-dimensional geometry, shared through instancing.
  const petalShape = new THREE.Shape(); petalShape.moveTo(0, 0); petalShape.bezierCurveTo(-0.23, 0.17, -0.25, 0.5, 0, 0.85); petalShape.bezierCurveTo(0.21, 0.58, 0.24, 0.21, 0, 0);
  const petalGeometry = new THREE.ShapeGeometry(petalShape, 5);
  const petalPositions = petalGeometry.attributes.position;
  for (let i = 0; i < petalPositions.count; i++) petalPositions.setZ(i, -Math.pow(petalPositions.getY(i), 2) * 0.23 + Math.abs(petalPositions.getX(i)) * 0.3);
  petalGeometry.computeVertexNormals();
  const leafShape = new THREE.Shape(); leafShape.moveTo(0, 0); leafShape.bezierCurveTo(-0.48, 0.22, -0.4, 0.57, 0, 0.94); leafShape.bezierCurveTo(0.4, 0.57, 0.48, 0.22, 0, 0);
  const leafGeometry = new THREE.ShapeGeometry(leafShape, 4);
  const leafPos = leafGeometry.attributes.position;
  for (let i = 0; i < leafPos.count; i++) leafPos.setZ(i, Math.sin(leafPos.getY(i) * 3) * 0.19 - Math.abs(leafPos.getX(i)) * 0.3);
  leafGeometry.computeVertexNormals();
  const petalTexture = own(brushTexture("#eab32b", ["#ffd958", "#c18211", "#ffec8a"], 128));
  const leafTexture = own(brushTexture("#727742", ["#a4a663", "#485831", "#bcaf61"], 128));
  const diskTexture = own(canvasTexture(256, (c, r) => {
    c.fillStyle = "#58431f"; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1400; i++) {
      const angle = i * 2.39996, radius = Math.sqrt(i / 1400) * 125;
      c.fillStyle = ["#785923", "#9b792d", "#483b21", "#c09336", "#674c21"][Math.floor(r() * 5)];
      c.beginPath(); c.ellipse(128 + Math.cos(angle) * radius, 128 + Math.sin(angle) * radius, 2.3, 1.6, angle, 0, Math.PI * 2); c.fill();
    }
  }));
  const flowers: { x: number; y: number; z: number; height: number; size: number; angle: number; tilt: number; giant?: boolean }[] = [];
  for (let i = 0; i < 5400; i++) {
    const x = (random() - 0.5) * 148, z = (random() - 0.5) * 156 - 13;
    if (Math.hypot(x, z + 15) < 7 || Math.hypot(x + 35, z + 35) < 9 || ((x - 34) / 15) ** 2 + ((z + 13) / 11) ** 2 < 1 || nearTrail(x, z, 2.15)) continue;
    const size = 0.26 + random() * 0.24;
    flowers.push({ x, y: terrainHeight(x, z), z, height: 0.8 + random() * 1.65, size, angle: random() * Math.PI * 2, tilt: (random() - 0.5) * 0.5 });
  }
  const vaseY = terrainHeight(0, -15);
  // The radial bouquet follows the silhouette of the 1888 still life.
  const heads = [
    [-3.4, 10.1, .3, 1.05], [-1.9, 12.4, .2, 1], [.6, 13.6, -.5, .95], [2.9, 12, -.5, 1.15],
    [4.1, 9.8, .6, 1.1], [-3.8, 8, 1.1, .9], [-1.4, 9.7, 1.8, 1.2], [1.1, 10.1, 2, 1.05],
    [3, 7.6, 1.6, .95], [-.1, 7.8, 2.5, 1], [-2.3, 7, .9, .8], [-2.1, 11, -2, .95],
    [1.3, 11.5, -2.1, 1.05], [3.3, 9, -1.5, .85], [-.2, 9.1, -2.4, .9],
  ];
  const bouquetScale = 1.32;
  for (const [x, h, z, size] of heads) flowers.push({ x: x * bouquetScale, y: vaseY + 4.7 * bouquetScale, z: -15 + z * bouquetScale, height: (h - 4.7) * bouquetScale, size: size * bouquetScale, angle: (random() - 0.5) * 1.4, tilt: (random() - 0.5) * 0.4, giant: true });
  const flowerCount = flowers.length;
  const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.032, 0.052, 1, 5), mat("#69713d"), flowerCount);
  const disks = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 6), mat("#8f691f"), flowerCount);
  const faces = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 16), mat("#ffffff", { map: diskTexture, side: THREE.DoubleSide }), flowerCount);
  const petals = new THREE.InstancedMesh(petalGeometry, mat("#ffffff", { map: petalTexture, side: THREE.DoubleSide }), flowerCount * 15);
  const leaves = new THREE.InstancedMesh(leafGeometry, mat("#ffffff", { map: leafTexture, side: THREE.DoubleSide }), flowerCount * 2);
  const head = new THREE.Object3D(), part = new THREE.Object3D();
  const matrix = new THREE.Matrix4();
  const start = new THREE.Vector3(), end = new THREE.Vector3(), direction = new THREE.Vector3();
  flowers.forEach((f, i) => {
    start.set(f.giant ? f.x * 0.16 : f.x, f.y, f.giant ? -15 + (f.z + 15) * 0.1 : f.z);
    end.set(f.x, f.y + f.height, f.z);
    direction.subVectors(end, start);
    temp.position.copy(start).addScaledVector(direction, 0.5); temp.quaternion.setFromUnitVectors(up, direction.clone().normalize()); temp.scale.setScalar(f.giant ? 2.9 : 1); temp.scale.y = direction.length(); temp.updateMatrix(); stems.setMatrixAt(i, temp.matrix);
    head.position.copy(end); head.rotation.set(f.tilt + 0.1, f.angle, (random() - .5) * .2); head.scale.setScalar(f.size); head.updateMatrix();
    part.position.set(0, 0, 0); part.rotation.set(0, 0, 0); part.scale.set(.44, .44, .2); part.updateMatrix(); matrix.multiplyMatrices(head.matrix, part.matrix); disks.setMatrixAt(i, matrix);
    part.position.z = .205; part.scale.set(.405, .405, 1); part.updateMatrix(); matrix.multiplyMatrices(head.matrix, part.matrix); faces.setMatrixAt(i, matrix);
    for (let p = 0; p < 15; p++) {
      const a = p / 15 * Math.PI * 2;
      part.position.set(Math.sin(a) * .31, Math.cos(a) * .31, .02 + random() * .05); part.rotation.set(random() * .3, 0, -a); part.scale.set(.65 + random() * .35, .63 + random() * .32, 1); part.updateMatrix(); matrix.multiplyMatrices(head.matrix, part.matrix); petals.setMatrixAt(i * 15 + p, matrix);
      color.setHSL(.11 + random() * .028, .76 + random() * .2, .46 + random() * .14); petals.setColorAt(i * 15 + p, color);
    }
    for (let l = 0; l < 2; l++) {
      temp.position.copy(start).addScaledVector(direction, .3 + l * .3); temp.rotation.set(.35, f.angle + l * 2.7, (l ? 1 : -1) * .95); temp.scale.setScalar(f.giant ? 1.45 : .55 + random() * .3); temp.updateMatrix(); leaves.setMatrixAt(i * 2 + l, temp.matrix);
    }
  });
  for (const m of [stems, disks, faces, petals, leaves]) { m.castShadow = m === disks || m === leaves; m.receiveShadow = true; m.computeBoundingSphere(); scene.add(m); }

  const grassGeometry = new THREE.ConeGeometry(.03, .55, 3);
  grassGeometry.translate(0, .4, 0);
  const grass = new THREE.InstancedMesh(grassGeometry, mat("#a8a15b"), 11000);
  let grassCount = 0;
  for (let i = 0; i < 11000; i++) {
    const x = (random() - .5) * 205, z = (random() - .5) * 195 - 12;
    if (nearTrail(x, z, 1.8) || Math.hypot(x, z + 15) < 5 || Math.hypot(x + 35, z + 35) < 7 || ((x - 34) / 14) ** 2 + ((z + 13) / 10) ** 2 < 1) continue;
    temp.position.set(x, terrainHeight(x, z), z); temp.rotation.set((random() - .5) * .45, random() * Math.PI, (random() - .5) * .45); temp.scale.set(1, .4 + random() * 1.1, 1); temp.updateMatrix(); grass.setMatrixAt(grassCount, temp.matrix); color.setHSL(.14 + random() * .04, .25 + random() * .3, .34 + random() * .22); grass.setColorAt(grassCount++, color);
  }
  grass.count = grassCount; scene.add(grass);

  const vaseTexture = own(canvasTexture(1024, (c, r) => {
    c.fillStyle = "#be8c35"; c.fillRect(0, 0, 1024, 1024); c.fillStyle = "#e0ba59"; c.fillRect(0, 0, 1024, 510);
    for (let i = 0; i < 16000; i++) { c.globalAlpha = .05 + r() * .18; c.fillStyle = ["#8e6624", "#f8d679", "#e0ba50", "#b49039"][Math.floor(r() * 4)]; c.fillRect(r() * 1024, r() * 1024, 1 + r() * 5, 5 + r() * 60); }
    c.globalAlpha = .8; c.fillStyle = "#715b31"; c.font = "italic 52px Georgia"; c.fillText("Vincent", 190, 700);
  }));
  const vaseProfile = [new THREE.Vector2(0, 0), new THREE.Vector2(1.4, 0), new THREE.Vector2(2, .3), new THREE.Vector2(2.6, 1), new THREE.Vector2(2.95, 2.3), new THREE.Vector2(2.75, 3.6), new THREE.Vector2(2.05, 4.7), new THREE.Vector2(1.6, 5.4), new THREE.Vector2(1.65, 5.6), new THREE.Vector2(1.44, 5.6), new THREE.Vector2(1.35, 5.1)];
  mesh(new THREE.LatheGeometry(vaseProfile, 64), mat("#ffffff", { map: vaseTexture, side: THREE.DoubleSide }), 0, vaseY + .1, -15).scale.setScalar(bouquetScale);
  mesh(new THREE.CylinderGeometry(1.38 * bouquetScale, 1.38 * bouquetScale, .08, 40), mat("#66562f"), 0, vaseY + 5.2 * bouquetScale, -15);
  const plinthTexture = own(brushTexture("#bc9451", ["#d9b56d", "#a17a3f"]));
  mesh(new THREE.CylinderGeometry(4.5, 4.7, .2, 64), mat("#cfaa62", { map: plinthTexture }), 0, vaseY, -15);

  // The yellow house is an imagined extension of the painting, inspired by Arles.
  const wallTexture = own(brushTexture("#d2b968", ["#f4df98", "#bfa257", "#e9cd7b"]));
  const wallMat = mat("#fff0ba", { map: wallTexture });
  const shutterMat = mat("#697f69", { map: leafTexture });
  const woodMat = mat("#6c6650");
  const hx = -35, hz = -35, hy = terrainHeight(hx, hz);
  box(9, 6.7, 7, wallMat, hx, hy + 3.35, hz);
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute("position", new THREE.Float32BufferAttribute([-5, 0, -4, 5, 0, -4, -5, 0, 4, 5, 0, 4, -5, 2.4, 0, 5, 2.4, 0], 3));
  roofGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0,0,1,0,0,0,1,0,0,1,1,1], 2));
  roofGeo.setIndex([0,4,1,1,4,5,2,3,4,3,5,4,0,2,4,1,5,3]); roofGeo.computeVertexNormals();
  mesh(roofGeo, mat("#a46f49", { side: THREE.DoubleSide, map: own(brushTexture("#a66d47", ["#c89463", "#815b42"])) }), hx, hy + 6.7, hz);
  box(.65, 2.5, .7, wallMat, hx - 2.8, hy + 8.2, hz - .9);
  for (const x of [-2.7, 0, 2.7]) {
    for (const y of [1.9, 4.9]) {
      if (x === 0 && y === 1.9) continue;
      box(1.05, 1.55, .14, woodMat, hx + x, hy + y, hz + 3.55);
      box(.55, 1.6, .12, shutterMat, hx + x - .79, hy + y, hz + 3.6);
      box(.55, 1.6, .12, shutterMat, hx + x + .79, hy + y, hz + 3.6);
      box(.06, 1.55, .16, wallMat, hx + x, hy + y, hz + 3.68);
      box(1.15, .07, .18, wallMat, hx + x, hy + y, hz + 3.68);
    }
  }
  box(1.25, 2.5, .15, shutterMat, hx, hy + 1.25, hz + 3.58);
  box(2.2, .18, .9, mat("#bdac84"), hx, hy + .09, hz + 3.95);
  const benchMat = mat("#736d47");
  for (const bx of [-41, 9]) {
    const bz = bx === 9 ? -66 : -28, by = terrainHeight(bx, bz);
    box(2.6, .13, .65, benchMat, bx, by + .75, bz); box(2.6, .7, .1, benchMat, bx, by + 1.15, bz - .3);
    for (const dx of [-1, 1]) box(.12, .8, .55, woodMat, bx + dx, by + .4, bz);
  }

  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = mat("#b8ae80", { flatShading: true });
  for (let i = 0; i < 56; i++) {
    const a = i / 56 * Math.PI * 2, x = 34 + Math.cos(a) * (12.2 + random()), z = -13 + Math.sin(a) * (8.5 + random());
    const rock = mesh(rockGeometry, rockMat, x, terrainHeight(x, z) + .2, z); rock.scale.set(.35 + random() * .7, .3 + random() * .4, .4 + random() * .6); rock.rotation.set(random(), random(), random());
  }
  const waterUniforms = { time: { value: 0 } };
  const water = mesh(new THREE.CircleGeometry(1, 80), new THREE.ShaderMaterial({
    uniforms: waterUniforms, side: THREE.DoubleSide,
    vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader: `varying vec2 vUv; uniform float time;
      void main(){float waves=sin(vUv.y*160.+sin(vUv.x*30.+time*.5)*2.+time)*.5+.5;
      float broad=sin(vUv.y*19.+sin(vUv.x*9.)+time*.1)*.5+.5;
      vec3 c=mix(vec3(.32,.47,.39),vec3(.64,.69,.48),broad*.65+waves*.16);
      c+=pow(waves,18.)*.09;gl_FragColor=vec4(c,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  }), 34, -.38, -13, false); water.rotation.x = -Math.PI / 2; water.scale.set(12.6, 8.6, 1);

  // Distant cypresses and painted rolling hills close the horizon without a hard wall.
  const cypressMat = mat("#52664b", { flatShading: true });
  for (let i = 0; i < 28; i++) {
    const x = (random() - .5) * 190, z = -64 - random() * 50;
    if (Math.hypot(x - 8, z + 67) < 12) continue;
    const y = terrainHeight(x, z), h = 5 + random() * 7;
    mesh(new THREE.CylinderGeometry(.16, .28, h * .4, 6), woodMat, x, y + h * .2, z);
    const tree = mesh(new THREE.SphereGeometry(1, 9, 9), cypressMat, x, y + h * .58, z); tree.scale.set(.8 + random() * .5, h * .54, .8 + random() * .4);
  }
  for (let i = 0; i < 22; i++) {
    const a = i / 22 * Math.PI * 2, x = Math.sin(a) * 158, z = Math.cos(a) * 158;
    const hill = mesh(new THREE.SphereGeometry(1, 24, 16), mat(i % 2 ? "#a5ae87" : "#b4b48a", { flatShading: false }), x, -4, z, false); hill.scale.set(25 + random() * 38, 12 + random() * 15, 25 + random() * 24);
  }

  // Tiny drifting flecks resemble suspended pigment in the afternoon light.
  const motePositions = new Float32Array(180 * 3);
  for (let i = 0; i < 180; i++) { motePositions[i * 3] = (random() - .5) * 100; motePositions[i * 3 + 1] = 1 + random() * 13; motePositions[i * 3 + 2] = (random() - .5) * 100; }
  const moteGeometry = new THREE.BufferGeometry(); moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
  const motes = new THREE.Points(moteGeometry, new THREE.PointsMaterial({ color: "#fff0b0", size: .065, transparent: true, opacity: .6, depthWrite: false })); scene.add(motes);

  function location() {
    let nearest = "向日葵花原";
    for (const p of PLACES) if (Math.hypot(player.x - p.x, player.z - p.z) < (p.id === "vase" ? 16 : 14)) nearest = p.name;
    return nearest;
  }
  function publish(walking = false) {
    onState({ x: player.x, z: player.z, heading: yaw, location: location(), discovered: [...discovered], walking });
  }
  function setCamera() {
    camera.position.set(player.x, terrainHeight(player.x, player.z) + 1.85 + jumpHeight + (photoMode ? 0 : Math.sin(walkPhase) * .028), player.z);
    camera.rotation.order = "YXZ"; camera.rotation.set(pitch, yaw, 0);
    camera.fov = cameraFov; camera.updateProjectionMatrix();
  }
  function updateLook(dx: number, dy: number) {
    yaw -= dx * .0022; pitch = THREE.MathUtils.clamp(pitch - dy * .0022, -1.35, 1.35);
  }
  function onMouseMove(event: MouseEvent) {
    if (paused) return;
    if (document.pointerLockElement === renderer.domElement) updateLook(event.movementX, event.movementY);
  }
  function onPointerDown(event: PointerEvent) {
    if (paused || document.pointerLockElement || event.button !== 0) return;
    dragging = true; dragX = event.clientX; dragY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
    renderer.domElement.focus({ preventScroll: true });
  }
  function onPointerMove(event: PointerEvent) {
    if (!dragging || document.pointerLockElement || paused) return;
    updateLook(event.clientX - dragX, event.clientY - dragY); dragX = event.clientX; dragY = event.clientY;
  }
  function onPointerUp() { dragging = false; }
  function onKeyDown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) event.preventDefault();
    keys.add(event.code);
    if (event.code === "Space" && jumpHeight === 0 && !paused && !photoMode && started) verticalSpeed = 6;
  }
  function onKeyUp(event: KeyboardEvent) { keys.delete(event.code); }
  function onBlur() { keys.clear(); dragging = false; }
  function onPointerLock() { keys.clear(); onLock(document.pointerLockElement === renderer.domElement); }
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("pointerlockchange", onPointerLock);
  window.addEventListener("blur", onBlur);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointercancel", onPointerUp);
  const resize = new ResizeObserver(() => {
    if (disposed || !container.clientWidth || !container.clientHeight) return;
    camera.aspect = container.clientWidth / container.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(container.clientWidth, container.clientHeight);
    if (paused) renderer.render(scene, camera);
  }); resize.observe(container);

  const mobile = { x: 0, y: 0 };
  function animate() {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    clock.update();
    const dt = Math.min(clock.getDelta(), .1); elapsed += dt;
    if (paused) return;
    let walking = false;
    if (!paused && started) {
      let forward = Number(keys.has("KeyW") || keys.has("ArrowUp")) - Number(keys.has("KeyS") || keys.has("ArrowDown")) + mobile.y;
      let strafe = Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft")) + mobile.x;
      const length = Math.hypot(forward, strafe);
      if (length > .1) {
        if (length > 1) { forward /= length; strafe /= length; }
        const speed = (photoMode ? 2.5 : keys.has("ShiftLeft") || keys.has("ShiftRight") ? 9 : 4.6) * dt;
        const dx = (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed;
        const dz = (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * speed;
        const nextX = player.x + dx, nextZ = player.z + dz;
        const allowed = (x: number, z: number) => Math.hypot(x, z) < 118 && !collisions.some(c => Math.hypot(x - c.x, z - c.z) < c.radius) && ((x - 34) / 12.8) ** 2 + ((z + 13) / 8.9) ** 2 > 1;
        if (allowed(nextX, nextZ)) { player.x = nextX; player.z = nextZ; walking = true; }
        else if (allowed(nextX, player.z)) { player.x = nextX; walking = true; }
        else if (allowed(player.x, nextZ)) { player.z = nextZ; walking = true; }
        if (walking) walkPhase += dt * 9;
      }
      if (jumpHeight > 0 || verticalSpeed > 0) { verticalSpeed -= 15 * dt; jumpHeight = Math.max(0, jumpHeight + verticalSpeed * dt); if (!jumpHeight) verticalSpeed = 0; }
      for (const p of PLACES) {
        if (!discovered.has(p.id) && Math.hypot(player.x - p.x, player.z - p.z) < 14) { discovered.add(p.id); onDiscovery(p.id); }
      }
    }
    if (!paused) { waterUniforms.time.value = elapsed; motes.rotation.y = elapsed * .005; }
    setCamera();
    renderer.render(scene, camera);
    if (elapsed - publishTime > .18) { publish(walking); publishTime = elapsed; }
  }
  setCamera(); publish(); animate();

  return {
    start() { started = true; paused = false; renderer.domElement.focus({ preventScroll: true }); },
    async lock() { if (document.pointerLockElement !== renderer.domElement) { try { await renderer.domElement.requestPointerLock(); } catch { /* Drag-to-look remains available in embedded browsers. */ } } },
    unlock() { if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); },
    pause(value: boolean) { paused = value; keys.clear(); mobile.x = mobile.y = 0; },
    setPhotoMode(value: boolean) { photoMode = value; cameraFov = value ? 50 : 62; jumpHeight = 0; verticalSpeed = 0; },
    setFocalLength(mm: number) { cameraFov = THREE.MathUtils.radToDeg(2 * Math.atan(36 / (2 * mm))); },
    setExposure(value: number) { exposure = value; renderer.toneMappingExposure = value; },
    setJoystick(x: number, y: number) { mobile.x = x; mobile.y = y; },
    restoreDiscoveries(ids: PlaceId[]) { ids.forEach(id => discovered.add(id)); publish(); },
    teleport(id: PlaceId) {
      const place = PLACES.find(p => p.id === id)!;
      const offsets: Record<PlaceId, [number, number]> = { vase: [1, 12], house: [0, 12], lake: [-2, 12], hill: [0, 8] };
      player.set(place.x + offsets[id][0], 0, place.z + offsets[id][1]); yaw = id === "hill" ? Math.PI : 0; pitch = id === "vase" ? .17 : -.025;
      jumpHeight = 0; verticalSpeed = 0; started = true; publish();
    },
    capture() {
      // Rendering immediately before reading avoids a persistent GPU buffer and excludes all HUD elements.
      setCamera(); renderer.render(scene, camera);
      return { url: renderer.domElement.toDataURL("image/jpeg", .93), location: location(), x: player.x, z: player.z, exposure };
    },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); clock.dispose();
      document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("keydown", onKeyDown); document.removeEventListener("keyup", onKeyUp); document.removeEventListener("pointerlockchange", onPointerLock); window.removeEventListener("blur", onBlur);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown); renderer.domElement.removeEventListener("pointermove", onPointerMove); renderer.domElement.removeEventListener("pointerup", onPointerUp); renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Points) { geometries.add(object.geometry); for (const m of Array.isArray(object.material) ? object.material : [object.material]) materials.add(m); } });
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); ownedTextures.forEach(t => t.dispose()); renderer.dispose(); renderer.domElement.remove();
    },
  };
}
