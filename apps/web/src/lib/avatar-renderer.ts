import { renderAvatar2d, renderAvatar3d } from '@pigeon-skin/minecraft';

export async function renderSkinAvatar(url: string, size = 100, mode: '2d' | '3d' = '2d') {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Avatar texture unavailable'));
    image.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas unavailable');
  context.drawImage(image, 0, 0);
  const skin = { width: canvas.width, height: canvas.height, rgba: new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  const output = (mode === '3d' ? renderAvatar3d : renderAvatar2d)(skin, size);
  canvas.width = output.width; canvas.height = output.height;
  context.putImageData(new ImageData(new Uint8ClampedArray(output.rgba), output.width, output.height), 0, 0);
  return canvas.toDataURL('image/png');
}
