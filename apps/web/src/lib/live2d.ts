const scripts = new Map<number, Promise<void>>();

export function selectTapMotion(areas: string[], groups: string[], idle: string): string | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const area of areas) {
    const match = groups.find(group => [ `tap${normalize(area)}`, `touch${normalize(area)}` ].includes(normalize(group)));
    if (match) return match;
  }
  return groups.find(group => normalize(group) === 'tap') || groups.find(group => group !== idle);
}

export function motionVoice(definition: unknown): string | undefined {
  if (!definition || typeof definition !== 'object') return;
  const value = definition as Record<string, unknown>;
  const sound = value.sound ?? value.Sound;
  return typeof sound === 'string' && sound ? sound : undefined;
}

export function loadLive2DCore(version: 2 | 4): Promise<void> {
  const existing = scripts.get(version);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = version === 2 ? '/live2d/runtime/live2d2.js' : '/live2d/runtime/live2dcubismcore.min.js';
    const timeout = window.setTimeout(() => {
      script.remove();
      scripts.delete(version);
      reject(new Error('Live2D core timeout'));
    }, 20000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      scripts.delete(version);
      reject(new Error('Live2D core unavailable'));
    };
    document.head.appendChild(script);
  });
  scripts.set(version, promise);
  return promise;
}
