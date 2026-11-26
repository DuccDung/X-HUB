import { journalMaxPhotoBytes } from './shared';
import type { JournalPhotoMime } from './shared';

export interface CompressedPhotoDraft {
  localId: string;
  previewUrl: string;
  dataBase64: string;
  mime: JournalPhotoMime;
  width: number;
  height: number;
  sizeBytes: number;
}

const MAX_EDGE = 1600;
const TARGET_BYTES = 750 * 1024;
const QUALITIES = [0.84, 0.72, 0.6, 0.48];

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      if (comma < 0) {
        reject(new Error('Không đọc được dữ liệu ảnh.'));
        return;
      }
      resolve(value.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Không đọc được tệp ảnh.'));
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Fallback to HTMLImageElement for browsers that do not support imageOrientation options or HEIC fallback.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error('Không thể đọc tệp ảnh này. Hãy chọn ảnh JPG, PNG hoặc WebP.'));
      node.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

export async function compressJournalPhoto(file: File): Promise<CompressedPhotoDraft> {
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error('Vui lòng chỉ chọn tệp hình ảnh.');
  }

  const decoded = await decodeImage(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Trình duyệt không hỗ trợ xử lý ảnh.');
    context.drawImage(decoded.source, 0, 0, width, height);

    let chosenBlob: Blob | null = null;
    let chosenMime: JournalPhotoMime = 'image/webp';

    // Prefer WebP when the browser supports encoding it; fallback to JPEG otherwise.
    const probeWebp = await canvasToBlob(canvas, 'image/webp', QUALITIES[0]);
    const preferredMime: JournalPhotoMime = probeWebp && probeWebp.type === 'image/webp'
      ? 'image/webp'
      : 'image/jpeg';

    for (const quality of QUALITIES) {
      const candidate = quality === QUALITIES[0] && preferredMime === 'image/webp' && probeWebp
        ? probeWebp
        : await canvasToBlob(canvas, preferredMime, quality);
      if (!candidate) continue;
      chosenBlob = candidate;
      chosenMime = preferredMime;
      if (candidate.size <= TARGET_BYTES) break;
    }

    if (!chosenBlob || chosenBlob.size === 0) {
      throw new Error('Không thể nén ảnh này. Bạn thử ảnh khác nhé.');
    }
    if (chosenBlob.size > journalMaxPhotoBytes) {
      throw new Error('Ảnh vẫn quá lớn sau khi nén. Bạn thử chọn ảnh gọn hơn nhé.');
    }

    const dataBase64 = await blobToBase64(chosenBlob);
    const previewUrl = URL.createObjectURL(chosenBlob);
    return {
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      previewUrl,
      dataBase64,
      mime: chosenMime,
      width,
      height,
      sizeBytes: chosenBlob.size,
    };
  } finally {
    decoded.close();
  }
}
