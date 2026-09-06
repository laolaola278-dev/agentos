"use client";

/* Photos are local data URLs, so they are displayed directly without a remote image optimizer. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { createWorld, PLACES, type PlaceId, type SunflowerWorld, type WorldState } from "./world";
import { deletePhotograph, readAlbum, savePhotograph, type Photograph } from "./album";
import { createAmbient } from "./ambient";
import "./sunflowers.css";

type IconName = "sun" | "camera" | "map" | "album" | "sound" | "mute" | "help" | "close" | "arrow" | "pin" | "expand" | "download" | "trash" | "check" | "flower" | "walk" | "focus";
function Icon({ name, size = 20, ...props }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    camera: <><path d="M4 6h4l1.5-2h5L16 6h4a1 1 0 0 1 1 1v12H3V7a1 1 0 0 1 1-1Z" /><circle cx="12" cy="12.5" r="4" /><path d="M17.5 9h.5" /></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15m6-12v15" /></>,
    album: <><rect x="4" y="3" width="17" height="17" rx="2" /><path d="M1 7v16h16M4 16l5-5 4 4 3-3 5 5" /><circle cx="16" cy="8" r="1.5" /></>,
    sound: <><path d="M11 4 6 8H3v8h3l5 4V4Zm4 4c3 2 3 6 0 8m3-11c5 4 5 10 0 14" /></>,
    mute: <><path d="M11 4 6 8H3v8h3l5 4V4Zm5 5 6 6m0-6-6 6" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 4h.01" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    expand: <path d="M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6" />,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    flower: <><circle cx="12" cy="12" r="3" /><path d="M10 9C4 2 15 0 14 8c7-6 11 4 2 6 6 7-4 11-6 2-7 6-11-4-2-6" /></>,
    walk: <><circle cx="14" cy="4" r="2" /><path d="m7 12 3-4 5 1 2 4 4 1m-9-5-2 6-5 6m5-6 5 2 1 5" /></>,
    focus: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" /><circle cx="12" cy="12" r="3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

type Panel = "map" | "album" | "help" | null;
const initialState: WorldState = { x: 15, z: 30, heading: .48, location: "向日葵花原", discovered: [], walking: false };

function WorldMap({ state, selected, onSelect }: { state: WorldState; selected: PlaceId; onSelect: (id: PlaceId) => void }) {
  const mx = (x: number) => 310 + x * 3.65, my = (z: number) => 360 + z * 3.55;
  return <svg className="sf-world-map" viewBox="0 0 640 560" role="group" aria-label="世界地图：向日葵之心、黄房子、池塘和远丘，圆点标记你的位置">
    <defs>
      <pattern id="map-paper" width="14" height="14" patternUnits="userSpaceOnUse"><path d="M0 7h14M7 0v14" stroke="#b3a779" strokeWidth=".3" opacity=".3" /></pattern>
      <pattern id="map-flowers" width="33" height="33" patternUnits="userSpaceOnUse"><g transform="translate(16 16)" stroke="#b09a52" fill="none" opacity=".38"><circle r="3" /><path d="M0-5v-3m0 13v3m5-8h3M-5 0h-3m4-4-2-2m10 10 2 2m0-12-2 2M-4 4l-2 2" /></g></pattern>
    </defs>
    <rect width="640" height="560" fill="#e6ddbd" /><rect width="640" height="560" fill="url(#map-paper)" />
    <path d="M20 170Q160 80 240 116T480 75T680 149M-20 187Q150 100 240 135T480 95T680 166M-20 202Q150 124 240 150T480 116T680 186" fill="none" stroke="#b5b58d" strokeWidth="1.2" opacity=".65" />
    <path d="M53 234Q105 99 235 155T488 187Q607 226 575 421T420 490Q277 540 134 464T53 234" fill="url(#map-flowers)" />
    <path d="M385 556C394 455 349 450 322 391S285 327 310 306M310 306Q260 301 182 257M310 306Q365 346 432 343M310 306Q270 224 339 123" fill="none" stroke="#c0aa76" strokeWidth="13" strokeLinecap="round" /><path d="M385 556C394 455 349 450 322 391S285 327 310 306M310 306Q260 301 182 257M310 306Q365 346 432 343M310 306Q270 224 339 123" fill="none" stroke="#f3e8c7" strokeWidth="8" strokeLinecap="round" />
    <ellipse cx="434" cy="307" rx="49" ry="32" fill="#a7b5a0" transform="rotate(-12 434 307)" /><path d="M409 298h38m-32 11h45m-38 9h25" stroke="#d2d8bf" strokeWidth="2" />
    <text x="93" y="392" fontSize="13" fill="#9a9069" letterSpacing="5" transform="rotate(-10 93 392)">向 日 葵 花 原</text>
    <g transform="translate(578 53)" stroke="#7a795b"><path d="M0-17v34m-7-25 7-9 7 9" fill="none" /><text y="-25" textAnchor="middle" stroke="none" fill="#7a795b" fontSize="11">N</text></g>
    {PLACES.map(p => <g key={p.id} className="sf-map-point" role="button" tabIndex={0} aria-label={`查看${p.name}`} onClick={() => onSelect(p.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.id); } }} transform={`translate(${mx(p.x)} ${my(p.z)})`}>
      {selected === p.id && <circle r="24" fill="none" stroke="#8b723b" opacity=".45" />}
      <circle r="16" fill={selected === p.id ? "#736344" : "#f8efd6"} stroke="#a18c55" />
      <text textAnchor="middle" y="5" fontSize="14" fill={selected === p.id ? "#fff5d8" : "#736344"}>{p.id === "vase" ? "✿" : p.id === "house" ? "⌂" : p.id === "lake" ? "≈" : "△"}</text>
      <rect x="-56" y="24" width="112" height="23" rx="11" fill="#eee5cb" fillOpacity=".9" />
      <text textAnchor="middle" y="39" fontSize="11" fill="#665c42">{p.name}{state.discovered.includes(p.id) ? " ✓" : ""}</text>
    </g>)}
    <g transform={`translate(${mx(state.x)} ${my(state.z)})`}><circle r="14" fill="#c27c49" opacity=".16" /><circle r="6" fill="#af653c" stroke="#fff4d4" strokeWidth="2" /><path d="M0-10-4-17 4-17Z" fill="#af653c" transform={`rotate(${-state.heading * 180 / Math.PI})`} /></g>
    <text x="28" y="532" fontSize="10" fill="#857b5e" letterSpacing="2">ARLES, AN IMAGINED LANDSCAPE · 1888</text>
  </svg>;
}

export default function SunflowerGame() {
  const host = useRef<HTMLDivElement>(null);
  const gameRoot = useRef<HTMLDivElement>(null);
  const world = useRef<SunflowerWorld | null>(null);
  const ambient = useRef<ReturnType<typeof createAmbient> | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);
  const [locked, setLocked] = useState(false);
  const [state, setState] = useState<WorldState>(initialState);
  const [panel, setPanel] = useState<Panel>(null);
  const [photoMode, setPhotoMode] = useState(false);
  const [photos, setPhotos] = useState<Photograph[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<PlaceId>("vase");
  const [sound, setSound] = useState(false);
  const [focalLength, setFocalLength] = useState(38);
  const [exposure, setExposure] = useState(1.18);
  const [grid, setGrid] = useState(true);
  const [flash, setFlash] = useState(false);
  const [toast, setToast] = useState("");
  const [discovery, setDiscovery] = useState<PlaceId | null>(null);
  const [saving, setSaving] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureBusy = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const notify = useCallback((message: string) => {
    setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 3600);
  }, []);

  useEffect(() => {
    if (!host.current) return;
    try {
      const game = createWorld(host.current, setState, id => {
        setDiscovery(id); if (discoveryTimer.current) clearTimeout(discoveryTimer.current); discoveryTimer.current = setTimeout(() => setDiscovery(null), 5500);
      }, setLocked);
      world.current = game;
      try { const data: unknown = JSON.parse(localStorage.getItem("sunflowers-discoveries") || "[]"); if (Array.isArray(data)) game.restoreDiscoveries(data.filter((id): id is PlaceId => PLACES.some(p => p.id === id))); } catch { /* Exploring is available even when storage is disabled. */ }
      const readyFrame = requestAnimationFrame(() => setReady(true));
      void readAlbum().then(setPhotos).catch(() => notify("本地相册暂不可用；拍摄后仍可下载照片。"));
      return () => { cancelAnimationFrame(readyFrame); game.dispose(); world.current = null; ambient.current?.dispose(); ambient.current = null; for (const timer of [toastTimer.current, discoveryTimer.current, flashTimer.current]) if (timer) clearTimeout(timer); };
    } catch (e) {
      const errorFrame = requestAnimationFrame(() => setError(e instanceof Error ? e.message : "无法创建三维画面"));
      return () => cancelAnimationFrame(errorFrame);
    }
  }, [notify]);

  useEffect(() => {
    if (state.discovered.length) { try { localStorage.setItem("sunflowers-discoveries", JSON.stringify(state.discovered)); } catch { /* Optional persistence. */ } }
  }, [state.discovered]);

  useEffect(() => {
    world.current?.pause(!!panel);
    if (panel) { world.current?.unlock(); panelRef.current?.focus(); }
  }, [panel]);

  const start = useCallback(() => { setStarted(true); world.current?.start(); void world.current?.lock(); }, []);
  const togglePhoto = useCallback(() => {
    if (!ready || panel) return;
    const next = !photoMode;
    setStarted(true); world.current?.start(); setPhotoMode(next); world.current?.setPhotoMode(next); world.current?.unlock();
    if (next) { world.current?.setFocalLength(focalLength); world.current?.setExposure(exposure); }
    else world.current?.setExposure(1.18);
  }, [ready, panel, photoMode, focalLength, exposure]);

  const takePhoto = useCallback(async () => {
    if (!world.current || captureBusy.current) return;
    captureBusy.current = true; setSaving(true);
    try {
      const shot = world.current.capture();
      const photo: Photograph = { id: crypto.randomUUID(), url: shot.url, location: shot.location, createdAt: new Date().toISOString(), focalLength };
      setPhotos(old => [photo, ...old]); setFlash(true); if (sound) ambient.current?.shutter();
      if (flashTimer.current) clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(false), 180);
      try { await savePhotograph(photo); notify("光被留住了 · 照片已存入旅途相册"); } catch { notify("照片已拍摄。本地存储已满或不可用，请在相册中下载保存。"); }
    } catch { notify("这次快门没有成功，请再试一次。"); }
    finally { captureBusy.current = false; setSaving(false); }
  }, [focalLength, notify, sound]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.repeat) return;
      if (event.code === "Escape") { if (selectedPhoto) setSelectedPhoto(null); else if (panel) setPanel(null); else if (photoMode) togglePhoto(); return; }
      if (event.code === "KeyC") { event.preventDefault(); togglePhoto(); }
      if (event.code === "KeyM") { event.preventDefault(); setPanel(old => old === "map" ? null : "map"); }
      if (event.code === "KeyP") { event.preventDefault(); setPanel(old => old === "album" ? null : "album"); }
      if (event.code === "KeyH") setPanel(old => old === "help" ? null : "help");
      if (event.code === "Enter" && !(event.target instanceof HTMLButtonElement) && !(event.target instanceof HTMLAnchorElement)) {
        if (photoMode && !panel) { event.preventDefault(); void takePhoto(); }
        else if (!started && !panel && ready) start();
      }
    };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [photoMode, panel, selectedPhoto, started, ready, start, togglePhoto, takePhoto]);

  // Keep keyboard focus inside an open panel, and return it to the scene on close.
  useEffect(() => {
    if (!panel) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, [tabindex="0"]')];
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap); return () => { document.removeEventListener("keydown", trap); previous?.focus({ preventScroll: true }); };
  }, [panel]);

  async function toggleSound() {
    try { ambient.current ??= createAmbient(); await ambient.current.setEnabled(!sound); setSound(!sound); }
    catch { notify("浏览器暂时无法播放环境声音。"); }
  }
  async function fullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await gameRoot.current?.requestFullscreen(); }
    catch { notify("当前窗口不支持全屏，仍可正常探索。"); }
  }
  const activePhoto = photos.find(p => p.id === selectedPhoto);
  const activePlace = PLACES.find(p => p.id === selectedPlace)!;
  const discoveredPlace = PLACES.find(p => p.id === discovery);
  const heading = ((-state.heading * 180 / Math.PI) % 360 + 360) % 360;

  return <div className={`sf-game ${photoMode ? "sf-is-camera" : ""} ${started ? "sf-is-playing" : ""}`} ref={gameRoot}>
    <div className="sf-scene" ref={host} />
    <div className="sf-grain" aria-hidden="true" />
    <div className="sf-vignette" aria-hidden="true" />

    {!photoMode && <>
      <header className="sf-header">
        <a className="sf-brand" href="/sunflowers" aria-label="画里有风，回到旅程起点"><span className="sf-brand-mark"><Icon name="flower" size={29} /></span><span>画里有风<small>A WORLD WITHIN A PAINTING</small></span></a>
        <div className="sf-compass" aria-label={`朝向 ${Math.round(heading)} 度`}><span>W</span><i /><span className="sf-compass-n">N</span><i /><span>E</span><b style={{ transform: `translateX(${Math.sin(state.heading) * 45}px)` }}>▾</b></div>
        <nav className="sf-nav" aria-label="游戏菜单">
          <button aria-label="世界地图" onClick={() => setPanel("map")}><Icon name="map" /><span>世界地图</span><kbd>M</kbd></button>
          <button aria-label="旅途相册" onClick={() => setPanel("album")}><Icon name="album" /><span>旅途相册</span>{photos.length > 0 && <em>{photos.length}</em>}</button>
          <span className="sf-nav-divider" />
          <button className="sf-icon-button" onClick={() => setPanel("help")} aria-label="操作指南"><Icon name="help" /></button>
        </nav>
      </header>

      {!started && <div className="sf-intro">
        <div className="sf-eyebrow"><span /> VINCENT VAN GOGH · 1888</div>
        <h1>向日葵<span>之外</span><i>Beyond the Sunflowers</i></h1>
        <p>如果能走进一幅画，<br />你想在那片金色里，停留多久？</p>
        <button className="sf-enter" onClick={start} disabled={!ready}>{ready ? "走进画中" : "正在唤醒花海"}<Icon name={ready ? "arrow" : "sun"} size={19} /></button>
        <div className="sf-intro-note">一场没有终点的漫游 · 自由探索 / 摄影</div>
      </div>}

      <div className="sf-weather"><Icon name="sun" size={18} /><span>永恒的午后</span><span className="sf-weather-line" /><span>阿尔勒，1888</span></div>

      {started && !panel && <div className="sf-aim" aria-hidden="true" />}

      <footer className="sf-footer">
        <div className="sf-location"><span className="sf-location-symbol"><Icon name="pin" size={22} /></span><div><small>此刻，你在</small><strong>{state.location}</strong><span className="sf-progress"><i style={{ width: `${state.discovered.length / 4 * 100}%` }} /></span><span className="sf-location-count">{String(state.discovered.length).padStart(2, "0")} / 04 处风景已发现</span></div></div>
        <div className="sf-controls"><span><span className="sf-wasd"><kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></span>自由行走</span><b /><span><svg width="17" height="25" viewBox="0 0 17 25" fill="none" aria-hidden="true"><rect x="1" y="1" width="15" height="23" rx="7.5" stroke="currentColor" /><path d="M8.5 1v8M1 10h15" stroke="currentColor" /></svg>{locked ? "移动视角" : "拖动环顾"}</span><b /><span><kbd>Shift</kbd>奔跑</span><span className="sf-jump-hint"><kbd>Space</kbd>跳跃</span></div>
        <div className="sf-camera-action"><span>收藏此刻的光<small>拿起相机 <kbd>C</kbd></small></span><button className="sf-camera-button" onClick={togglePhoto} disabled={!ready} aria-label="拿起相机 C"><Icon name="camera" size={27} /></button></div>
      </footer>
      <div className="sf-utilities"><button onClick={toggleSound} className={sound ? "sf-sound-on" : ""} aria-label={sound ? "关闭环境声音" : "开启环境声音"} title={sound ? "关闭环境声音" : "开启环境声音"}><Icon name={sound ? "sound" : "mute"} size={17} /></button><button onClick={fullscreen} aria-label="切换全屏" title="切换全屏"><Icon name="expand" size={16} /></button></div>
      {started && !locked && !panel && <button className="sf-resume" onClick={() => void world.current?.lock()}>点击锁定视角 <span>· Esc 释放鼠标</span></button>}
    </>}

    {photoMode && <div className="sf-camera-ui">
      <div className="sf-camera-top"><div><span className="sf-live-dot" />取景器 <small>THE ART OF NOTICING</small></div><button onClick={togglePhoto}><Icon name="close" size={18} />放下相机 <kbd>C</kbd></button></div>
      <div className={`sf-viewfinder ${grid ? "sf-show-grid" : ""}`} aria-hidden="true"><i /><i /><i /><i /><div className="sf-grid-v" /><div className="sf-grid-h" /><div className="sf-focus-bracket"><span /></div></div>
      <div className="sf-camera-readout"><span>{state.location}</span><span>JPEG · {focalLength} MM · 自然光</span></div>
      <div className="sf-camera-bottom">
        <div className="sf-lens-controls"><label>焦距 <strong>{focalLength}<small>mm</small></strong><input aria-label="相机焦距" type="range" min="24" max="85" value={focalLength} onChange={e => { const value = +e.target.value; setFocalLength(value); world.current?.setFocalLength(value); }} /></label><label>曝光 <strong>{((exposure - 1.18) * 2).toFixed(1)}<small>EV</small></strong><input aria-label="相机曝光" type="range" min="0.6" max="1.9" step="0.02" value={exposure} onChange={e => { const value = +e.target.value; setExposure(value); world.current?.setExposure(value); }} /></label></div>
        <div className="sf-shutter-wrap"><button className="sf-shutter" onClick={() => void takePhoto()} disabled={saving} aria-label="拍摄照片"><span /></button><small>{saving ? "正在保存…" : "按 Enter · 留住此刻"}</small></div>
        <div className="sf-camera-options"><button onClick={() => setGrid(!grid)} aria-pressed={grid}><Icon name="focus" size={19} />{grid ? "关闭构图线" : "开启构图线"}</button><button aria-label="旅途相册" onClick={() => setPanel("album")}><Icon name="album" size={19} />旅途相册 <span>{photos.length}</span></button></div>
      </div>
      <p className="sf-camera-tip">拖动环顾 · WASD 移动 · 调整焦距，寻找你的画面</p>
    </div>}

    {started && !panel && <div className="sf-touch-controls" aria-label="触屏移动方向">
      {([['前进', 0, 1, '↑'], ['左移', -1, 0, '←'], ['后退', 0, -1, '↓'], ['右移', 1, 0, '→']] as const).map(([label, x, y, symbol]) => <button key={label} aria-label={label} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); world.current?.setJoystick(x, y); }} onPointerUp={() => world.current?.setJoystick(0, 0)} onPointerCancel={() => world.current?.setJoystick(0, 0)} onLostPointerCapture={() => world.current?.setJoystick(0, 0)}>{symbol}</button>)}
    </div>}

    {discoveredPlace && !panel && <div className="sf-discovery" role="status"><Icon name="flower" size={24} /><small>你发现了一处新风景</small><strong>{discoveredPlace.name}</strong><span>{discoveredPlace.subtitle}</span></div>}

    {panel && <div className="sf-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setPanel(null); setSelectedPhoto(null); } }}>
      <section className={`sf-panel sf-panel-${panel}`} role="dialog" aria-modal="true" aria-labelledby="sf-panel-title" tabIndex={-1} ref={panelRef}>
        <div className="sf-panel-heading"><div><span className="sf-panel-eyebrow">{panel === "map" ? "A LITTLE WORLD, ENDLESS WANDERING" : panel === "album" ? "MOMENTS YOU CHOSE TO KEEP" : "MAKE YOURSELF AT HOME"}</span><h2 id="sf-panel-title">{panel === "map" ? "循着光，去远方" : panel === "album" ? "旅途相册" : "在画里，慢慢走"}</h2></div><button className="sf-panel-close" onClick={() => { setPanel(null); setSelectedPhoto(null); }} aria-label="关闭面板"><Icon name="close" size={23} /></button></div>
        {panel === "map" && <div className="sf-map-layout"><WorldMap state={state} selected={selectedPlace} onSelect={setSelectedPlace} /><div className="sf-map-details"><span className="sf-detail-number">0{PLACES.findIndex(p => p.id === selectedPlace) + 1} / 04</span><Icon name={selectedPlace === "vase" ? "flower" : "pin"} size={36} /><h3>{activePlace.name}</h3><small>{activePlace.subtitle}</small><p>{activePlace.description}</p><span className="sf-discovered-label">{state.discovered.includes(selectedPlace) ? <><Icon name="check" size={15} />已经遇见的风景</> : "等待你发现"}</span><button className="sf-paper-button" onClick={() => { world.current?.teleport(selectedPlace); setStarted(true); setPanel(null); notify(`已抵达${activePlace.name}附近`); }}>前往这里<Icon name="arrow" size={18} /></button><p className="sf-map-note">也可以收起地图，沿小径步行抵达。<br />这片世界，不必赶路。</p></div></div>}
        {panel === "album" && <>
          <div className="sf-album-summary"><span>{photos.length} 张光的切片</span><span>保存在当前浏览器 · 可下载原图</span></div>
          {activePhoto ? <div className="sf-photo-detail"><button className="sf-back" onClick={() => setSelectedPhoto(null)}>← 返回相册</button><img src={activePhoto.url} alt={`${activePhoto.location}的摄影作品`} /><div><span>{activePhoto.location}<small>{new Date(activePhoto.createdAt).toLocaleString("zh-CN")} · {activePhoto.focalLength} mm</small></span><a className="sf-paper-button" href={activePhoto.url} download={`画里有风-${activePhoto.location}-${activePhoto.id.slice(0, 8)}.jpg`}><Icon name="download" size={17} />下载照片</a></div></div> : photos.length ? <div className="sf-photo-grid">{photos.map((photo, i) => <article className="sf-photo-card" key={photo.id}><button className="sf-photo-open" onClick={() => setSelectedPhoto(photo.id)} aria-label={`查看${photo.location}的照片`}><img src={photo.url} alt={`${photo.location}，旅途照片 ${photos.length - i}`} /><span>{photo.location}<small>NO. {String(photos.length - i).padStart(3, "0")}</small></span></button><div className="sf-photo-card-footer"><time>{new Date(photo.createdAt).toLocaleDateString("zh-CN")}</time><a href={photo.url} download={`画里有风-${photo.location}-${photo.id.slice(0, 8)}.jpg`} aria-label={`下载${photo.location}的照片`}><Icon name="download" size={16} /></a><button aria-label={`删除${photo.location}的照片`} onClick={async () => { try { await deletePhotograph(photo.id); setPhotos(old => old.filter(p => p.id !== photo.id)); notify("已删除这张照片"); } catch { notify("删除未成功，请稍后再试。"); } }}><Icon name="trash" size={15} /></button></div></article>)}</div> : <div className="sf-empty-album"><div><Icon name="camera" size={46} /></div><h3>有些光，值得停下脚步</h3><p>拿起相机，为你的第一次漫游留一张照片。</p><button className="sf-paper-button" onClick={() => { setPanel(null); setStarted(true); world.current?.start(); setPhotoMode(true); world.current?.setPhotoMode(true); world.current?.setFocalLength(focalLength); world.current?.setExposure(exposure); }}>去拍第一张<Icon name="arrow" size={18} /></button></div>}
        </>}
        {panel === "help" && <div className="sf-help-content"><p className="sf-help-intro">这里没有倒计时，也没有必须完成的任务。<br />你只需要走进花海，找到属于自己的那一抹黄色。</p><div className="sf-help-keys">{[["W A S D / ↑ ↓ ← →", "自由行走"], ["鼠标 / 触屏拖动", "环顾四周"], ["Shift", "奔跑"], ["Space", "跳跃"], ["C", "拿起 / 放下相机"], ["Enter", "在相机模式中拍摄"], ["M / P", "世界地图 / 旅途相册"], ["Esc", "释放鼠标 / 关闭面板"]].map(([key, label]) => <div key={key}><span>{label}</span><kbd>{key}</kbd></div>)}</div><div className="sf-about-art"><Icon name="flower" size={26} /><div><h3>从一幅静物，到一片旷野</h3><p>灵感来自文森特·梵高 1888 年的《向日葵》。花瓶、花束与赭黄的桌面被转译为立体景观；黄房子、池塘和远丘，是从画中延伸的想象。</p><small>程序化 3D 艺术创作 · 致敬梵高 · 非画作的精确复原</small></div></div><button className="sf-paper-button" onClick={() => { setPanel(null); if (!started) start(); }}>出发，慢慢看<Icon name="arrow" size={18} /></button></div>}
        <div className="sf-panel-bottom"><Icon name="flower" size={15} /><span>画里有风</span><span>TAKE YOUR TIME. THE LIGHT WILL WAIT.</span></div>
      </section>
    </div>}

    {toast && <div className="sf-toast" role="status"><Icon name="check" size={17} />{toast}</div>}
    {flash && <div className="sf-flash" />}
    {!ready && !error && <div className="sf-loading"><Icon name="flower" size={42} /><span>每一朵花，都在等风来。</span><small>正在铺开这片金色的世界…</small></div>}
    {error && <div className="sf-loading sf-error"><Icon name="sun" size={38} /><h2>这片花海需要三维图形支持</h2><p>请在支持 WebGL 的浏览器中打开，并开启硬件加速。</p><details><summary>查看详情</summary>{error}</details><button className="sf-paper-button" onClick={() => window.location.reload()}>重新加载</button></div>}
  </div>;
}
