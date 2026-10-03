const frameOrigin = location.origin;
let currentKind = 'skin';
let currentModel = 'default';
let initialName = 'untitled';
let dirty = false;
const language = (() => {
  const value = new URLSearchParams(location.search).get('site_lang')?.toLowerCase() || 'en';
  return value === 'zh-cn' ? 'zh' : value === 'zh-tw' ? 'zh_tw' : value.replace('-', '_');
})();
const skinLabels = {
  zh: ['腰部', '头部', '头部外层', '身体', '身体外层', '右臂', '右臂外层', '左臂', '左臂外层', '右腿', '右腿外层', '左腿', '左腿外层'],
  zh_tw: ['腰部', '頭部', '頭部外層', '身體', '身體外層', '右臂', '右臂外層', '左臂', '左臂外層', '右腿', '右腿外層', '左腿', '左腿外層'],
  es: ['Cintura', 'Cabeza', 'Capa de cabeza', 'Cuerpo', 'Capa del cuerpo', 'Brazo derecho', 'Capa del brazo derecho', 'Brazo izquierdo', 'Capa del brazo izquierdo', 'Pierna derecha', 'Capa de la pierna derecha', 'Pierna izquierda', 'Capa de la pierna izquierda'],
  ja: ['腰', '頭', '頭の外側', '胴体', '胴体の外側', '右腕', '右腕の外側', '左腕', '左腕の外側', '右脚', '右脚の外側', '左脚', '左脚の外側'],
  ru: ['Талия', 'Голова', 'Внешний слой головы', 'Тело', 'Внешний слой тела', 'Правая рука', 'Внешний слой правой руки', 'Левая рука', 'Внешний слой левой руки', 'Правая нога', 'Внешний слой правой ноги', 'Левая нога', 'Внешний слой левой ноги'],
};
const skinParts = ['Waist', 'Head', 'Hat Layer', 'Body', 'Body Layer', 'Right Arm', 'Right Arm Layer', 'Left Arm', 'Left Arm Layer', 'Right Leg', 'Right Leg Layer', 'Left Leg', 'Left Leg Layer'];
const capeParts = ['cape', 'elytra', 'left_wing', 'right_wing'];
const capeLabels = {
  zh: ['披风', '鞘翅', '左翼', '右翼'],
  zh_tw: ['披風', '鞘翅', '左翼', '右翼'],
  es: ['Capa', 'Élitros', 'Ala izquierda', 'Ala derecha'],
  ja: ['マント', 'エリトラ', '左翼', '右翼'],
  ru: ['Плащ', 'Элитры', 'Левое крыло', 'Правое крыло'],
};

function send(message) { parent.postMessage(message, frameOrigin); }
function dataUrlToBlob(dataUrl) {
  const [header, body] = dataUrl.split(',');
  const bytes = Uint8Array.from(atob(body || ''), value => value.charCodeAt(0));
  return new Blob([bytes], { type: header?.match(/:(.*?);/)?.[1] || 'image/png' });
}
function activeTexture() { return window.Texture?.all?.[0] || window.Texture?.getDefault?.(); }
function markDirty() {
  if (dirty) return;
  dirty = true;
  send({ type: 'editor:change', dirty, model: currentModel });
}
function observe() {
  if (!window.Blockbench?.setup_successful || !window.Formats?.skin?.setup_dialog) {
    setTimeout(observe, 120);
    return;
  }
  window.onbeforeunload = null;
  if (Object.prototype.hasOwnProperty.call(window, '__editorPreviousSettings')) {
    const previous = window.__editorPreviousSettings;
    if (previous === null) localStorage.removeItem('settings');
    else localStorage.setItem('settings', previous);
    delete window.__editorPreviousSettings;
  }
  window.Blockbench.on('finished_edit', markDirty);
  pruneRuntimeSurface();
  send({ type: 'editor:ready' });
}
function pruneRuntimeSurface() {
  if (window.Formats) {
    for (const id of Object.keys(window.Formats)) if (id !== 'skin') delete window.Formats[id];
  }
  document.querySelectorAll('#mode_selector > *, [id*="animation"], [class*="animation"], [id*="display_mode"]').forEach(node => node.remove());
}
function exportTexture(type = 'editor:export') {
  const texture = activeTexture();
  if (!texture) return;
  const dataUrl = texture.getDataURL();
  if (!dataUrl) return;
  const image = dataUrlToBlob(dataUrl);
  if (type === 'editor:save') {
    send({ type, image, width: texture.img?.naturalWidth || window.Project?.texture_width || 64, height: texture.img?.naturalHeight || window.Project?.texture_height || 64 });
    dirty = false;
    send({ type: 'editor:change', dirty, model: currentModel });
  } else {
    send({ type, image, width: texture.img?.naturalWidth || 64, height: texture.img?.naturalHeight || 64 });
  }
}
function loadProject(message) {
  currentKind = message.kind === 'cape' ? 'cape' : 'skin';
  currentModel = message.model === 'slim' ? 'slim' : 'default';
  initialName = message.name || (currentKind === 'cape' ? 'cape' : 'skin');
  const dialog = window.Formats.skin.setup_dialog;
  const preset = currentKind === 'cape' ? 'cape_elytra' : currentModel === 'slim' ? 'alex' : 'steve';
  dialog.show();
  dialog.setFormValues({
    model: preset,
    resolution: 1,
    texture_source: message.image ? 'upload_texture' : 'template',
    ...(message.image ? { texture_file: { name: `${initialName}.png`, path: '', content: '' } } : {}),
    pose: false,
    layer_template: true,
  });
  if (message.image) {
    const reader = new FileReader();
    reader.onload = () => {
      dialog.setFormValues({ texture_file: { name: `${initialName}.png`, path: '', content: String(reader.result) } });
      setTimeout(() => dialog.object?.querySelector('.confirm_btn')?.click(), 50);
      finishLoad();
    };
    reader.onerror = () => send({ type: 'editor:error', message: '无法读取 PNG 纹理' });
    reader.readAsDataURL(message.image);
  } else {
    setTimeout(() => dialog.object?.querySelector('.confirm_btn')?.click(), 50);
    finishLoad();
  }
}
function finishLoad() {
  setTimeout(() => {
    localizeSkinParts();
    window.Modes?.options?.paint?.select();
    dirty = false;
    send({ type: 'editor:change', dirty, model: currentModel });
  }, 50);
}

function localizeSkinParts() {
  const parts = currentKind === 'cape' ? capeParts : skinParts;
  const labels = currentKind === 'cape' ? capeLabels[language] : skinLabels[language];
  if (!labels) return;
  const localized = Object.fromEntries(parts.map((part, index) => [part, labels[index]]));
  for (const item of [...(window.Group?.all || []), ...(window.Cube?.all || [])]) {
    if (localized[item.name]) item.name = localized[item.name];
    if (item.children) item.isOpen = true;
  }
  window.Outliner?.update?.();
}

addEventListener('message', event => {
  if (event.origin !== frameOrigin || event.source !== parent) return;
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'editor:init') loadProject(message);
  if (message.type === 'editor:command') {
    if (message.command === 'createSkin' || message.command === 'createCape') loadProject({ kind: message.command === 'createCape' ? 'cape' : 'skin', model: message.model, name: initialName, image: null });
    if (message.command === 'loadTexture' && message.kind) loadProject({ kind: message.kind, model: message.model, name: initialName, image: message.image || null });
    if (message.command === 'undo') window.Undo?.undo();
    if (message.command === 'redo') window.Undo?.redo();
    if (message.command === 'export') exportTexture();
    if (message.command === 'save') exportTexture('editor:save');
  }
});

observe();
