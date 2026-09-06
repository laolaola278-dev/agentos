export type Photograph = {
  id: string;
  url: string;
  location: string;
  createdAt: string;
  focalLength: number;
};

const DB_NAME = "sunflowers-journey";
function openAlbum(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("photographs", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readAlbum(): Promise<Photograph[]> {
  const db = await openAlbum();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("photographs", "readonly").objectStore("photographs").getAll();
      request.onsuccess = () => resolve((request.result as Photograph[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function savePhotograph(photo: Photograph) {
  const db = await openAlbum();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("photographs", "readwrite");
      tx.objectStore("photographs").put(photo);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function deletePhotograph(id: string) {
  const db = await openAlbum();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("photographs", "readwrite");
      tx.objectStore("photographs").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
