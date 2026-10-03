// Blessing Skin 静态预览渲染器。
// 基于 bs-community/texture-renderer（MIT，© The Blessing Skin Team）。

import { LIMITS } from '@pigeon-skin/shared';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8，每像素 4 字节 */
  readonly rgba: Uint8Array;
}

interface Point3 { x: number; y: number; z: number }

class Pt {
  origin: Point3;
  dest: Point3 = { x: 0, y: 0, z: 0 };
  projected = false;
  preProjected = false;
  constructor(p: Point3) { this.origin = p; }

  preProject(dx: number, dy: number, dz: number, ca: number, sa: number, co: number, so: number): void {
    if (this.preProjected) return;
    const x = this.origin.x - dx;
    const y = this.origin.y - dy;
    const z = this.origin.z - dz;
    const nx = x * co + z * so;
    const ny = x * sa * so + y * ca - z * sa * co;
    const nz = -x * ca * so + y * sa + z * ca * co;
    this.origin = { x: nx + dx, y: ny + dy, z: nz + dz };
    this.preProjected = true;
  }

  project(ca: number, sa: number, co: number, so: number, bounds: Bounds): void {
    if (this.projected) return;
    const { x, y, z } = this.origin;
    this.dest = {
      x: x * co + z * so,
      y: x * sa * so + y * ca - z * sa * co,
      z: -x * ca * so + y * sa + z * ca * co,
    };
    this.projected = true;
    bounds.minX = Math.min(bounds.minX, this.dest.x);
    bounds.maxX = Math.max(bounds.maxX, this.dest.x);
    bounds.minY = Math.min(bounds.minY, this.dest.y);
    bounds.maxY = Math.max(bounds.maxY, this.dest.y);
  }

  depth(): number { return this.dest.z; }
}

interface Bounds { minX: number; maxX: number; minY: number; maxY: number }

type FaceName = 'back' | 'right' | 'top' | 'front' | 'left' | 'bottom';
type Piece = 'helmet' | 'head' | 'torso' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';

interface Poly {
  dots: Pt[];
  /** RGBA 采样值（0xAABBGGRR 与 GD imagecolorat 一致：alpha 在高位） */
  color: number;
}

const ALL_FACES: FaceName[] = ['back', 'right', 'top', 'front', 'left', 'bottom'];

function cubeCorners(): Array<[Pt, FaceName[]]> {
  return [
    [new Pt({ x: 0, y: 0, z: 0 }), ['back', 'right', 'top']],
    [new Pt({ x: 0, y: 0, z: 1 }), ['front', 'right', 'top']],
    [new Pt({ x: 0, y: 1, z: 0 }), ['back', 'right', 'bottom']],
    [new Pt({ x: 0, y: 1, z: 1 }), ['front', 'right', 'bottom']],
    [new Pt({ x: 1, y: 0, z: 0 }), ['back', 'left', 'top']],
    [new Pt({ x: 1, y: 0, z: 1 }), ['front', 'left', 'top']],
    [new Pt({ x: 1, y: 1, z: 0 }), ['back', 'left', 'bottom']],
    [new Pt({ x: 1, y: 1, z: 1 }), ['front', 'left', 'bottom']],
  ];
}

export interface RendererOptions {
  /** 采样密度，原版默认 7；越大越清晰 */
  ratio?: number;
  headOnly?: boolean;
  hR?: number;
  vR?: number;
  layers?: boolean;
}

export class SkinRenderer {
  private ratio: number;
  private headOnly: boolean;
  private hR: number;
  private vR: number;
  private layers: boolean;
  private isAlex = false;

  private hd = 1;
  private isNewSkinType = false;
  /** ABGR（0xAABBGGRR，与 canvas Uint32 小端像序一致），取色函数按 GD 语义换算 */
  private data: Uint32Array = new Uint32Array(0);
  private sw = 0;
  private sh = 0;

  private bounds: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  private polys: Record<Piece, Record<FaceName, Poly[]>>;
  private memberAngles: Record<string, { ca: number; sa: number; co: number; so: number }> = {};
  private frontFaces: FaceName[] = [];
  private backFaces: FaceName[] = [];
  private visibleFaces: Record<Piece, { front: FaceName[]; back: FaceName[] }>;

  constructor(opts: RendererOptions = {}) {
    this.ratio = opts.ratio ?? 7;
    this.headOnly = opts.headOnly ?? false;
    this.hR = opts.hR ?? 145;
    this.vR = opts.vR ?? -25;
    this.layers = opts.layers ?? true;
    const empty = (): Record<FaceName, Poly[]> => ({
      front: [], back: [], top: [], bottom: [], left: [], right: [],
    });
    this.polys = {
      helmet: empty(), head: empty(), torso: empty(),
      rightArm: empty(), leftArm: empty(), rightLeg: empty(), leftLeg: empty(),
    };
    const vf = () => ({ front: [] as FaceName[], back: [] as FaceName[] });
    this.visibleFaces = {
      head: vf(), helmet: vf(), torso: vf(),
      rightArm: vf(), leftArm: vf(), rightLeg: vf(), leftLeg: vf(),
    };
  }

  setAlex(v: boolean): void { this.isAlex = v; }

  /** 采样皮肤像素。GD imagecolorat 返回 0xAABBGGRR；输入按小端 Uint32 解读，一致 */
  private px(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.sw || y >= this.sh) return 0;
    return this.data[y * this.sw + x]!;
  }

  render(skin: RgbaImage): RgbaImage {
    // 宽 > 256 的 HD 皮肤先降采样到 256（对照 SkinRenderer.php:81-89 的防护）：
    // 合法上传允许到 1024 宽，不降采样的话 Poly 数量按 hd² 增长（1024 宽 ≈ 53
    // 万个四边形、数百 MB），足以打爆 DO 内存
    let work = skin;
    if (skin.width > 256) {
      const w = 256;
      const h = Math.round((skin.height * 256) / skin.width);
      work = { width: w, height: h, rgba: nearestScale(skin, w, h) };
    }
    this.sw = work.width;
    this.sh = work.height;
    // RGBA 字节 → 小端 Uint32（0xAABBGGRR），与 canvas getImageData().buffer
    // 直接转 Uint32Array 的像序完全一致
    this.data = new Uint32Array(toArrayBuffer(work.rgba));

    this.hd = this.sw / 64;
    this.isNewSkinType = this.sw === this.sh;

    if (this.layers && this.isNewSkinType) this.fixNewSkinTypeLayers();

    this.calculateAngles();
    this.facesDetermination();
    this.generatePolygons();
    this.memberRotation();
    this.projectAll();
    return this.displayImage();
  }

  /** 1.8 双层：把第二层 UV 区 alpha-over 合成进第一层（原版 fixNewSkinTypeLayers） */
  private fixNewSkinTypeLayers(): void {
    const hd = this.hd;
    // PHP imagecopy(dst,src,dx,dy,sx,sy,w,h) 经 gdImageSetPixel 是 **alpha 混合**
    // （libgd truecolor→truecolor 走 setPixel），不是覆盖式拷贝 —— overlay
    // 不透明处覆盖 base、透明处透出 base。三个方向的 dst←src 逐一对照
    // SkinRenderer.php:198-206，方向反了第二层衣物会整层消失（Round 4 实证）。
    this.blit(0, 16 * hd, 0, 32 * hd, 56 * hd, 16 * hd);   // RL2/BODY2/RA2 overlay → base 带 y+16
    this.blit(16 * hd, 48 * hd, 0, 48 * hd, 16 * hd, 16 * hd);  // LL2 → 左腿 base
    this.blit(32 * hd, 48 * hd, 48 * hd, 48 * hd, 16 * hd, 16 * hd); // LA2 → 左臂 base
  }

  /**
   * 把 (sx,sy) 起的 w×h 区域 **alpha-over 合成**到 (dx,dy)。
   * 对照 libgd gdImageCopy 的 setPixel 语义；同图拷贝需要 src 快照
   * （三个调用点的 dst/src 区域互不重叠，快照只为防御未来改动）。
   */
  private blit(dx: number, dy: number, sx: number, sy: number, w: number, h: number): void {
    const src = this.data.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const from = (sy + y) * this.sw + (sx + x);
        const to = (dy + y) * this.sw + (dx + x);
        if (to < 0 || to >= this.data.length || from < 0 || from >= src.length) continue;
        const s = src[from]!;
        const sa = (s >>> 24) & 0xff;
        if (sa === 0) continue; // overlay 全透明处透出 base
        if (sa === 255) { this.data[to] = s; continue; }
        const d = this.data[to]!;
        const da = (d >>> 24) & 0xff;
        const outA = sa + (da * (255 - sa)) / 255;
        if (outA === 0) { this.data[to] = 0; continue; }
        const mix = (sc: number, dc: number): number =>
          Math.round((sc * sa + dc * da * (255 - sa) / 255) / outA);
        this.data[to] =
          ((Math.round(outA) & 0xff) << 24) |
          (mix((s >>> 16) & 0xff, (d >>> 16) & 0xff) & 0xff) << 16 |
          (mix((s >>> 8) & 0xff, (d >>> 8) & 0xff) & 0xff) << 8 |
          (mix(s & 0xff, d & 0xff) & 0xff);
      }
    }
  }

  private calculateAngles(): void {
    const mk = (va: number, vo: number) => ({
      ca: Math.cos((va * Math.PI) / 180), sa: Math.sin((va * Math.PI) / 180),
      co: Math.cos((vo * Math.PI) / 180), so: Math.sin((vo * Math.PI) / 180),
    });
    this.memberAngles = {
      torso: { ca: 1, sa: 0, co: 1, so: 0 },
      head: mk(0, 0), helmet: mk(0, 0),
      rightArm: mk(0, 0), leftArm: mk(0, 0),
      rightLeg: mk(0, 0), leftLeg: mk(0, 0),
    };
  }

  /** 判定整体视角下每个立方体的可见面（原版 facesDetermination） */
  private facesDetermination(): void {
    const ca = Math.cos((this.vR * Math.PI) / 180);
    const sa = Math.sin((this.vR * Math.PI) / 180);
    const co = Math.cos((this.hR * Math.PI) / 180);
    const so = Math.sin((this.hR * Math.PI) / 180);

    const determine = (piece: Piece, angles: { ca: number; sa: number; co: number; so: number }): void => {
      let best: [Pt, FaceName[]] | null = null;
      let bestDepth = Infinity;
      for (const [pt, backFaces] of cubeCorners()) {
        pt.preProject(0, 0, 0, angles.ca, angles.sa, angles.co, angles.so);
        pt.project(ca, sa, co, so, this.bounds);
        const d = pt.depth();
        if (best === null || d < bestDepth) { best = [pt, backFaces]; bestDepth = d; }
      }
      const back = best![1];
      this.visibleFaces[piece].back = back;
      this.visibleFaces[piece].front = ALL_FACES.filter((f) => !back.includes(f));
    };

    for (const p of Object.keys(this.visibleFaces) as Piece[]) determine(p, this.memberAngles[p]!);

    let best: [Pt, FaceName[]] | null = null;
    let bestDepth = Infinity;
    for (const [pt, backFaces] of cubeCorners()) {
      pt.project(ca, sa, co, so, this.bounds);
      const d = pt.depth();
      if (best === null || d < bestDepth) { best = [pt, backFaces]; bestDepth = d; }
    }
    this.backFaces = best![1];
    this.frontFaces = ALL_FACES.filter((f) => !this.backFaces.includes(f));
  }

  private poly(piece: Piece, face: FaceName, dots: Pt[], color: number): void {
    this.polys[piece][face].push({ dots, color });
  }

  /** 生成全部逐像素四边形（原版 generatePolygons 的 UV 采样表） */
  private generatePolygons(): void {
    const hd = this.hd;
    const alex = this.isAlex;

    // ── HEAD（8³ 立方体，z ∈ [-2,6]）─────────────────────────────────────────
    const headPts = (i: number, j: number, k: number) => new Pt({ x: i / hd, y: j / hd, z: k / hd });
    for (let i = 0; i < 8 * hd; i++) {
      for (let j = 0; j < 8 * hd; j++) {
        this.poly('head', 'back', [headPts(i, j, -2 * hd), headPts(i + 1, j, -2 * hd), headPts(i + 1, j + 1, -2 * hd), headPts(i, j + 1, -2 * hd)],
          this.px(32 * hd - 1 - i, 8 * hd + j));
        this.poly('head', 'front', [headPts(i, j, 6 * hd), headPts(i + 1, j, 6 * hd), headPts(i + 1, j + 1, 6 * hd), headPts(i, j + 1, 6 * hd)],
          this.px(8 * hd + i, 8 * hd + j));
      }
    }
    for (let j = 0; j < 8 * hd; j++) {
      for (let k = -2 * hd; k < 6 * hd; k++) {
        this.poly('head', 'right', [headPts(0, j, k), headPts(0, j, k + 1), headPts(0, j + 1, k + 1), headPts(0, j + 1, k)],
          this.px(k + 2 * hd, 8 * hd + j));
        this.poly('head', 'left', [headPts(8 * hd, j, k), headPts(8 * hd, j, k + 1), headPts(8 * hd, j + 1, k + 1), headPts(8 * hd, j + 1, k)],
          this.px(24 * hd - 1 - k - 2 * hd, 8 * hd + j));
      }
    }
    for (let i = 0; i < 8 * hd; i++) {
      for (let k = -2 * hd; k < 6 * hd; k++) {
        this.poly('head', 'top', [headPts(i, 0, k), headPts(i + 1, 0, k), headPts(i + 1, 0, k + 1), headPts(i, 0, k + 1)],
          this.px(8 * hd + i, k + 2 * hd));
        this.poly('head', 'bottom', [headPts(i, 8 * hd, k), headPts(i + 1, 8 * hd, k), headPts(i + 1, 8 * hd, k + 1), headPts(i, 8 * hd, k + 1)],
          this.px(16 * hd + i, 2 * hd + k));
      }
    }

    // ── HELMET（第二层头，9/8 缩放外扩半像素，UV 在 +32 区）───────────────────
    const helPt = (i: number, j: number, k: number) => new Pt({
      x: i / hd * 9 / 8 - 0.5,
      y: j / hd * 9 / 8 - 0.5,
      z: k / hd * 9 / 8 - 0.5,
    });
    for (let i = 0; i < 8 * hd; i++) {
      for (let j = 0; j < 8 * hd; j++) {
        this.poly('helmet', 'back', [helPt(i, j, -2 * hd), helPt(i + 1, j, -2 * hd), helPt(i + 1, j + 1, -2 * hd), helPt(i, j + 1, -2 * hd)],
          this.px(32 * hd + (32 * hd - 1) - i, 8 * hd + j));
        this.poly('helmet', 'front', [helPt(i, j, 6 * hd), helPt(i + 1, j, 6 * hd), helPt(i + 1, j + 1, 6 * hd), helPt(i, j + 1, 6 * hd)],
          this.px(32 * hd + 8 * hd + i, 8 * hd + j));
      }
    }
    for (let j = 0; j < 8 * hd; j++) {
      for (let k = -2 * hd; k < 6 * hd; k++) {
        this.poly('helmet', 'right', [helPt(0, j, k), helPt(0, j, k + 1), helPt(0, j + 1, k + 1), helPt(0, j + 1, k)],
          this.px(32 * hd + k + 2 * hd, 8 * hd + j));
        this.poly('helmet', 'left', [helPt(8 * hd, j, k), helPt(8 * hd, j, k + 1), helPt(8 * hd, j + 1, k + 1), helPt(8 * hd, j + 1, k)],
          this.px(32 * hd + (24 * hd - 1) - k - 2 * hd, 8 * hd + j));
      }
    }
    for (let i = 0; i < 8 * hd; i++) {
      for (let k = -2 * hd; k < 6 * hd; k++) {
        this.poly('helmet', 'top', [helPt(i, 0, k), helPt(i + 1, 0, k), helPt(i + 1, 0, k + 1), helPt(i, 0, k + 1)],
          this.px(32 * hd + 8 * hd + i, k + 2 * hd));
        this.poly('helmet', 'bottom', [helPt(i, 8 * hd, k), helPt(i + 1, 8 * hd, k), helPt(i + 1, 8 * hd, k + 1), helPt(i, 8 * hd, k + 1)],
          this.px(32 * hd + 16 * hd + i, 2 * hd + k));
      }
    }

    if (this.headOnly) return;

    // ── TORSO（x 0..8, y 8..20, z 0..4）──────────────────────────────────────
    const torsoPt = (i: number, j: number, k: number) => new Pt({ x: i / hd, y: j / hd + 8, z: k / hd });
    for (let i = 0; i < 8 * hd; i++) {
      for (let j = 0; j < 12 * hd; j++) {
        this.poly('torso', 'back', [torsoPt(i, j, 0), torsoPt(i + 1, j, 0), torsoPt(i + 1, j + 1, 0), torsoPt(i, j + 1, 0)],
          this.px(40 * hd - 1 - i, 20 * hd + j));
        this.poly('torso', 'front', [torsoPt(i, j, 4 * hd), torsoPt(i + 1, j, 4 * hd), torsoPt(i + 1, j + 1, 4 * hd), torsoPt(i, j + 1, 4 * hd)],
          this.px(20 * hd + i, 20 * hd + j));
      }
    }
    for (let j = 0; j < 12 * hd; j++) {
      for (let k = 0; k < 4 * hd; k++) {
        this.poly('torso', 'right', [torsoPt(0, j, k), torsoPt(0, j, k + 1), torsoPt(0, j + 1, k + 1), torsoPt(0, j + 1, k)],
          this.px(16 * hd + k, 20 * hd + j));
        this.poly('torso', 'left', [torsoPt(8 * hd, j, k), torsoPt(8 * hd, j, k + 1), torsoPt(8 * hd, j + 1, k + 1), torsoPt(8 * hd, j + 1, k)],
          this.px(32 * hd - 1 - k, 20 * hd + j));
      }
    }
    for (let i = 0; i < 8 * hd; i++) {
      for (let k = 0; k < 4 * hd; k++) {
        this.poly('torso', 'top', [torsoPt(i, 0, k), torsoPt(i + 1, 0, k), torsoPt(i + 1, 0, k + 1), torsoPt(i, 0, k + 1)],
          this.px(20 * hd + i, 16 * hd + k));
        this.poly('torso', 'bottom', [torsoPt(i, 12 * hd, k), torsoPt(i + 1, 12 * hd, k), torsoPt(i + 1, 12 * hd, k + 1), torsoPt(i, 12 * hd, k + 1)],
          this.px(28 * hd + i, 20 * hd - 1 - k));
      }
    }

    // ── RIGHT ARM（x -4..0 / 0..4，UV 在 40..56）──────────────────────────────
    const raPt = (i: number, j: number, k: number) => new Pt({ x: i / hd - (alex ? 3 : 4), y: j / hd + 8, z: k / hd });
    const raW = alex ? 3 * hd : 4 * hd;
    for (let i = 0; i < raW; i++) {
      for (let j = 0; j < 12 * hd; j++) {
        this.poly('rightArm', 'back', [raPt(i, j, 0), raPt(i + 1, j, 0), raPt(i + 1, j + 1, 0), raPt(i, j + 1, 0)],
          this.px((alex ? 54 : 56) * hd - 1 - i, 20 * hd + j));
        this.poly('rightArm', 'front', [raPt(i, j, 4 * hd), raPt(i + 1, j, 4 * hd), raPt(i + 1, j + 1, 4 * hd), raPt(i, j + 1, 4 * hd)],
          this.px(44 * hd + i, 20 * hd + j));
      }
    }
    for (let j = 0; j < 12 * hd; j++) {
      for (let k = 0; k < 4 * hd; k++) {
        this.poly('rightArm', 'right', [raPt(0, j, k), raPt(0, j, k + 1), raPt(0, j + 1, k + 1), raPt(0, j + 1, k)],
          this.px(40 * hd + k, 20 * hd + j));
        this.poly('rightArm', 'left', [raPt(raW, j, k), raPt(raW, j, k + 1), raPt(raW, j + 1, k + 1), raPt(raW, j + 1, k)],
          this.px((alex ? 51 : 56) * hd - 1 - k, 20 * hd + j));
      }
    }
    for (let i = 0; i < raW; i++) {
      for (let k = 0; k < 4 * hd; k++) {
        this.poly('rightArm', 'top', [raPt(i, 0, k), raPt(i + 1, 0, k), raPt(i + 1, 0, k + 1), raPt(i, 0, k + 1)],
          this.px(44 * hd + i, 16 * hd + k));
        this.poly('rightArm', 'bottom', [raPt(i, 12 * hd, k), raPt(i + 1, 12 * hd, k), raPt(i + 1, 12 * hd, k + 1), raPt(i, 12 * hd, k + 1)],
          this.px((alex ? 47 : 48) * hd + i, 16 * hd + k));
      }
    }

    // ── LEFT ARM（x 8..12，UV 在 32..48（新版）/ 40..56（旧版映射））────────────
    const laPt = (i: number, j: number, k: number) => new Pt({ x: i / hd + 8, y: j / hd + 8, z: k / hd });
    const laW = alex ? 3 * hd : 4 * hd;
    for (let i = 0; i < laW; i++) {
      for (let j = 0; j < 12 * hd; j++) {
        let c1: number, c2: number;
        if (alex) {
          c1 = this.px(46 * hd - 1 - i, 52 * hd + j);
          c2 = this.px(36 * hd + i, 52 * hd + j);
        } else if (this.isNewSkinType) {
          c1 = this.px(48 * hd - 1 - i, 52 * hd + j);
          c2 = this.px(36 * hd + i, 52 * hd + j);
        } else {
          c1 = this.px((56 * hd - 1) - ((4 * hd - 1) - i), 20 * hd + j);
          c2 = this.px(44 * hd + ((4 * hd - 1) - i), 20 * hd + j);
        }
        this.poly('leftArm', 'back', [laPt(i, j, 0), laPt(i + 1, j, 0), laPt(i + 1, j + 1, 0), laPt(i, j + 1, 0)], c1);
        this.poly('leftArm', 'front', [laPt(i, j, 4 * hd), laPt(i + 1, j, 4 * hd), laPt(i + 1, j + 1, 4 * hd), laPt(i, j + 1, 4 * hd)], c2);
      }
    }
    for (let j = 0; j < 12 * hd; j++) {
      for (let k = 0; k < 4 * hd; k++) {
        let c1: number, c2: number;
        if (this.isNewSkinType) {
          c1 = this.px(32 * hd + k, 52 * hd + j);
          c2 = this.px((alex ? 43 : 44) * hd - 1 - k, 52 * hd + j);
        } else {
          c1 = this.px(40 * hd + ((4 * hd - 1) - k), 20 * hd + j);
          c2 = this.px((52 * hd - 1) - ((4 * hd - 1) - k), 20 * hd + j);
        }
        this.poly('leftArm', 'right', [laPt(0, j, k), laPt(0, j, k + 1), laPt(0, j + 1, k + 1), laPt(0, j + 1, k)], c1);
        this.poly('leftArm', 'left', [laPt(laW, j, k), laPt(laW, j, k + 1), laPt(laW, j + 1, k + 1), laPt(laW, j + 1, k)], c2);
      }
    }
    for (let i = 0; i < laW; i++) {
      for (let k = 0; k < 4 * hd; k++) {
        let c1: number, c2: number;
        if (alex) {
          c1 = this.px(36 * hd + i, 48 * hd + k);
          c2 = this.px(39 * hd + i, 48 * hd + k);
        } else if (this.isNewSkinType) {
          c1 = this.px(36 * hd + i, 48 * hd + k);
          c2 = this.px(40 * hd + i, 48 * hd + k);
        } else {
          c1 = this.px(44 * hd + ((4 * hd - 1) - i), 16 * hd + k);
          c2 = this.px(48 * hd + ((4 * hd - 1) - i), (20 * hd - 1) - k);
        }
        this.poly('leftArm', 'top', [laPt(i, 0, k), laPt(i + 1, 0, k), laPt(i + 1, 0, k + 1), laPt(i, 0, k + 1)], c1);
        this.poly('leftArm', 'bottom', [laPt(i, 12 * hd, k), laPt(i + 1, 12 * hd, k), laPt(i + 1, 12 * hd, k + 1), laPt(i, 12 * hd, k + 1)], c2);
      }
    }

    // ── RIGHT LEG（x 0..4, y 20..32）─────────────────────────────────────────
    const rlPt = (i: number, j: number, k: number) => new Pt({ x: i / hd, y: j / hd + 20, z: k / hd });
    for (let i = 0; i < 4 * hd; i++) {
      for (let j = 0; j < 12 * hd; j++) {
        this.poly('rightLeg', 'back', [rlPt(i, j, 0), rlPt(i + 1, j, 0), rlPt(i + 1, j + 1, 0), rlPt(i, j + 1, 0)],
          this.px(16 * hd - 1 - i, 20 * hd + j));
        this.poly('rightLeg', 'front', [rlPt(i, j, 4 * hd), rlPt(i + 1, j, 4 * hd), rlPt(i + 1, j + 1, 4 * hd), rlPt(i, j + 1, 4 * hd)],
          this.px(4 * hd + i, 20 * hd + j));
      }
    }
    for (let j = 0; j < 12 * hd; j++) {
      for (let k = 0; k < 4 * hd; k++) {
        this.poly('rightLeg', 'right', [rlPt(0, j, k), rlPt(0, j, k + 1), rlPt(0, j + 1, k + 1), rlPt(0, j + 1, k)],
          this.px(k, 20 * hd + j));
        this.poly('rightLeg', 'left', [rlPt(4 * hd, j, k), rlPt(4 * hd, j, k + 1), rlPt(4 * hd, j + 1, k + 1), rlPt(4 * hd, j + 1, k)],
          this.px(12 * hd - 1 - k, 20 * hd + j));
      }
    }
    for (let i = 0; i < 4 * hd; i++) {
      for (let k = 0; k < 4 * hd; k++) {
        this.poly('rightLeg', 'top', [rlPt(i, 0, k), rlPt(i + 1, 0, k), rlPt(i + 1, 0, k + 1), rlPt(i, 0, k + 1)],
          this.px(4 * hd + i, 16 * hd + k));
        this.poly('rightLeg', 'bottom', [rlPt(i, 12 * hd, k), rlPt(i + 1, 12 * hd, k), rlPt(i + 1, 12 * hd, k + 1), rlPt(i, 12 * hd, k + 1)],
          this.px(8 * hd + i, 16 * hd + k));
      }
    }

    // ── LEFT LEG（x 4..8, y 20..32；新版 UV 在 y 48..64 区）───────────────────
    const llPt = (i: number, j: number, k: number) => new Pt({ x: i / hd + 4, y: j / hd + 20, z: k / hd });
    for (let i = 0; i < 4 * hd; i++) {
      for (let j = 0; j < 12 * hd; j++) {
        let c1: number, c2: number;
        if (this.isNewSkinType) {
          c1 = this.px(32 * hd - 1 - i, 52 * hd + j);
          c2 = this.px(20 * hd + i, 52 * hd + j);
        } else {
          c1 = this.px((16 * hd - 1) - ((4 * hd - 1) - i), 20 * hd + j);
          c2 = this.px(4 * hd + ((4 * hd - 1) - i), 20 * hd + j);
        }
        this.poly('leftLeg', 'back', [llPt(i, j, 0), llPt(i + 1, j, 0), llPt(i + 1, j + 1, 0), llPt(i, j + 1, 0)], c1);
        this.poly('leftLeg', 'front', [llPt(i, j, 4 * hd), llPt(i + 1, j, 4 * hd), llPt(i + 1, j + 1, 4 * hd), llPt(i, j + 1, 4 * hd)], c2);
      }
    }
    for (let j = 0; j < 12 * hd; j++) {
      for (let k = 0; k < 4 * hd; k++) {
        let c1: number, c2: number;
        if (this.isNewSkinType) {
          c1 = this.px(16 * hd + k, 52 * hd + j);
          c2 = this.px(28 * hd - 1 - k, 52 * hd + j);
        } else {
          c1 = this.px((4 * hd - 1) - k, 20 * hd + j);
          c2 = this.px(12 * hd - 1 - ((4 * hd - 1) - k), 20 * hd + j);
        }
        this.poly('leftLeg', 'right', [llPt(0, j, k), llPt(0, j, k + 1), llPt(0, j + 1, k + 1), llPt(0, j + 1, k)], c1);
        this.poly('leftLeg', 'left', [llPt(4 * hd, j, k), llPt(4 * hd, j, k + 1), llPt(4 * hd, j + 1, k + 1), llPt(4 * hd, j + 1, k)], c2);
      }
    }
    for (let i = 0; i < 4 * hd; i++) {
      for (let k = 0; k < 4 * hd; k++) {
        let c1: number, c2: number;
        if (this.isNewSkinType) {
          c1 = this.px(20 * hd + i, 48 * hd + k);
          c2 = this.px(24 * hd + i, 48 * hd + k);
        } else {
          c1 = this.px(4 * hd + ((4 * hd - 1) - i), 16 * hd + k);
          c2 = this.px(8 * hd + ((4 * hd - 1) - i), (20 * hd - 1) - k);
        }
        this.poly('leftLeg', 'top', [llPt(i, 0, k), llPt(i + 1, 0, k), llPt(i + 1, 0, k + 1), llPt(i, 0, k + 1)], c1);
        this.poly('leftLeg', 'bottom', [llPt(i, 12 * hd, k), llPt(i + 1, 12 * hd, k), llPt(i + 1, 12 * hd, k + 1), llPt(i, 12 * hd, k + 1)], c2);
      }
    }
  }

  /** 部位旋转原点（原版 memberRotation） */
  private memberRotation(): void {
    const rot = (piece: Piece, dx: number, dy: number, dz: number, sinSign: number): void => {
      const a = this.memberAngles[piece]!;
      for (const face of Object.values(this.polys[piece])) {
        for (const p of face) {
          for (const d of p.dots) d.preProject(dx, dy, sinSign < 0 && dz === 4 ? 0 : dz, a.ca, a.sa, a.co, a.so);
        }
      }
    };
    rot('head', 4, 8, 2, 1);
    rot('helmet', 4, 8, 2, 1);
    if (!this.headOnly) {
      rot('rightArm', -2, 8, 2, 1);
      rot('leftArm', 10, 8, 2, 1);
      rot('rightLeg', 2, 20, 4, this.memberAngles.rightLeg!.sa);
      rot('leftLeg', 6, 20, 4, this.memberAngles.leftLeg!.sa);
    }
  }

  /** 全局视角投影（原版 createProjectionPlan） */
  private projectAll(): void {
    const ca = Math.cos((this.vR * Math.PI) / 180);
    const sa = Math.sin((this.vR * Math.PI) / 180);
    const co = Math.cos((this.hR * Math.PI) / 180);
    const so = Math.sin((this.hR * Math.PI) / 180);
    for (const piece of Object.keys(this.polys) as Piece[]) {
      for (const face of Object.values(this.polys[piece])) {
        for (const p of face) {
          for (const d of p.dots) d.project(ca, sa, co, so, this.bounds);
        }
      }
    }
  }

  /** 光栅化（原版 displayImage：2x 超采样 + 缩半；canvas fill → 扫描线填充） */
  private displayImage(): RgbaImage {
    const width = this.bounds.maxX - this.bounds.minX;
    const height = this.bounds.maxY - this.bounds.minY;
    const ratio = this.ratio * 2;
    const w = Math.ceil(ratio * width + 1);
    const h = Math.ceil(ratio * height + 1);

    // RGBA 光栅（预乘前），0 = 未绘制
    const canvasRgba = new Uint8Array(w * h * 4);
    const paint = (x: number, y: number, r: number, g: number, b: number, alpha: number): void => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const o = (y * w + x) * 4;
      const a = alpha / 255;
      const dstA = canvasRgba[o + 3]! / 255;
      const outA = a + dstA * (1 - a);
      if (outA <= 0) return;
      canvasRgba[o] = Math.round((r * a + canvasRgba[o]! * dstA * (1 - a)) / outA);
      canvasRgba[o + 1] = Math.round((g * a + canvasRgba[o + 1]! * dstA * (1 - a)) / outA);
      canvasRgba[o + 2] = Math.round((b * a + canvasRgba[o + 2]! * dstA * (1 - a)) / outA);
      canvasRgba[o + 3] = Math.round(outA * 255);
    };

    const order = this.displayOrder();
    for (const group of order) {
      for (const [piece, faces] of group) {
        for (const face of faces) {
          for (const p of this.polys[piece]![face] ?? []) {
            this.fillPoly(p, ratio, paint);
          }
        }
      }
    }

    // 缩半抗锯齿（2×2 盒滤波，对应 canvas 版 drawImage 的 2x 缩小）
    const outW = Math.ceil(w / 2);
    const outH = Math.ceil(h / 2);
    const out = new Uint8Array(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(w - 1, x * 2 + dx);
            const sy = Math.min(h - 1, y * 2 + dy);
            const o = (sy * w + sx) * 4;
            const sa = canvasRgba[o + 3]! / 255;
            r += canvasRgba[o]! * sa;
            g += canvasRgba[o + 1]! * sa;
            b += canvasRgba[o + 2]! * sa;
            a += sa;
          }
        }
        const o = (y * outW + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
          out[o + 3] = Math.round((a / 4) * 255);
        }
      }
    }
    return { width: outW, height: outH, rgba: out };
  }

  /**
   * 凸四边形扫描线填充（替代 canvas fill()）。
   * 共享边左闭右开，避免相邻四边形间出现缝隙或双重混合。
   */
  private fillPoly(
    poly: Poly, ratio: number,
    paint: (x: number, y: number, r: number, g: number, b: number, alpha: number) => void,
  ): void {
    const color = poly.color;
    const alpha = (color >>> 24) & 0xff;
    if (alpha === 0) return;
    const r = color & 0xff;
    const g = (color >>> 8) & 0xff;
    const b = (color >>> 16) & 0xff;

    // 顶点转光栅坐标。无需收缩：x 跨度左闭右开 + y 半开交点判定
    // 已保证相邻四边形在共享边上恰好覆盖一次（两侧用同一交点、同一线段分割）
    const pts = poly.dots.map((d) => ({
      x: (d.dest.x - this.bounds.minX) * ratio,
      y: (d.dest.y - this.bounds.minY) * ratio,
    }));

    const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
    const maxY = Math.ceil(Math.max(...pts.map((p) => p.y)));
    for (let y = minY; y <= maxY; y++) {
      const sy = y + 0.5;
      // 求扫描线与四边形各边的交点 x
      const xs: number[] = [];
      for (let i = 0; i < 4; i++) {
        const a = pts[i]!, c = pts[(i + 1) % 4]!;
        if ((a.y <= sy && c.y > sy) || (c.y <= sy && a.y > sy)) {
          xs.push(a.x + ((sy - a.y) / (c.y - a.y)) * (c.x - a.x));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((m, n) => m - n);
      const x0 = Math.max(0, Math.ceil(xs[0]!));
      const x1 = Math.ceil(xs[xs.length - 1]!); // 右开
      for (let x = x0; x < x1; x++) paint(x, y, r, g, b, alpha);
    }
  }

  /** 绘制顺序（原版 getDisplayOrder，简化为与等价的两分支） */
  private displayOrder(): Array<Array<[Piece, FaceName[]]>> {
    const order: Array<Array<[Piece, FaceName[]]>> = [];
    const front = this.frontFaces;
    const back = this.backFaces;
    const vf = (p: Piece, which: 'front' | 'back') => this.visibleFaces[p]![which];
    const g = (p: Piece, faces: FaceName[]): [Piece, FaceName[]] => [p, faces];

    if (front.includes('top')) {
      if (front.includes('right')) {
        order.push([g('leftLeg', back), g('leftLeg', vf('leftLeg', 'front')),
          g('rightLeg', back), g('rightLeg', vf('rightLeg', 'front')),
          g('leftArm', back), g('leftArm', vf('leftArm', 'front')),
          g('torso', back), g('torso', vf('torso', 'front')),
          g('rightArm', back), g('rightArm', vf('rightArm', 'front'))]);
      } else {
        order.push([g('rightLeg', back), g('rightLeg', vf('rightLeg', 'front')),
          g('leftLeg', back), g('leftLeg', vf('leftLeg', 'front')),
          g('rightArm', back), g('rightArm', vf('rightArm', 'front')),
          g('torso', back), g('torso', vf('torso', 'front')),
          g('leftArm', back), g('leftArm', vf('leftArm', 'front'))]);
      }
      order.push([g('helmet', back), g('head', back),
        g('head', vf('head', 'front')), g('helmet', vf('head', 'front'))]);
    } else {
      order.push([g('helmet', back), g('head', back),
        g('head', vf('head', 'front')), g('helmet', vf('head', 'front'))]);
      if (front.includes('right')) {
        order.push([g('leftArm', back), g('leftArm', vf('leftArm', 'front')),
          g('torso', back), g('torso', vf('torso', 'front')),
          g('rightArm', back), g('rightArm', vf('rightArm', 'front')),
          g('leftLeg', back), g('leftLeg', vf('leftLeg', 'front')),
          g('rightLeg', back), g('rightLeg', vf('rightLeg', 'front'))]);
      } else {
        order.push([g('rightArm', back), g('rightArm', vf('rightArm', 'front')),
          g('torso', back), g('torso', vf('torso', 'front')),
          g('leftArm', back), g('leftArm', vf('leftArm', 'front')),
          g('rightLeg', back), g('rightLeg', vf('rightLeg', 'front')),
          g('leftLeg', back), g('leftLeg', vf('leftLeg', 'front'))]);
      }
    }
    return order;
  }
}

/** 最近邻缩放（HD 降采样防护用） */
function nearestScale(src: RgbaImage, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw));
      const s = (sy * src.width + sx) * 4;
      const d = (y * dw + x) * 4;
      out[d] = src.rgba[s]!; out[d + 1] = src.rgba[s + 1]!;
      out[d + 2] = src.rgba[s + 2]!; out[d + 3] = src.rgba[s + 3]!;
    }
  }
  return out;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.length);
  new Uint8Array(out).set(data);
  return out;
}

/**
 * 组合"背面 + 正面"两帧（原版 Minecraft::renderSkin，ratio=7，135°/-45°）。
 * isAlex 传入皮肤的模型类型。
 */
export function renderSkinDual(skin: RgbaImage, isAlex: boolean): RgbaImage {
  const vp = 15, hp = 30, ip = 15;
  const mk = (hR: number): RgbaImage => {
    const r = new SkinRenderer({ ratio: 7, headOnly: false, hR, vR: -25 });
    r.setAlex(isAlex);
    return r.render(skin);
  };
  const front = mk(-45);
  const back = mk(135);

  const width = (hp + front.width + ip) * 2;
  const height = vp * 2 + front.height;
  const out = new Uint8Array(width * height * 4);
  blitImage(out, width, back, hp, vp);
  blitImage(out, width, front, hp + front.width + ip * 2, vp);
  return { width, height, rgba: out };
}

function blitImage(dst: Uint8Array, dstW: number, src: RgbaImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      if (src.rgba[s + 3]! === 0) continue;
      const d = ((dy + y) * dstW + (dx + x)) * 4;
      dst[d] = src.rgba[s]!; dst[d + 1] = src.rgba[s + 1]!;
      dst[d + 2] = src.rgba[s + 2]!; dst[d + 3] = src.rgba[s + 3]!;
    }
  }
}

/** 2D 头像（正面头部特写，原版 render2dAvatar：headOnly + 无旋转，ratio=15） */
export function render2dAvatar(skin: RgbaImage): RgbaImage {
  const r = new SkinRenderer({ ratio: 15, headOnly: true, hR: 0, vR: 0 });
  return r.render(skin);
}
export function render3dAvatar(skin: RgbaImage): RgbaImage {
  const renderer = new SkinRenderer({ ratio: 15, headOnly: true, hR: 45, vR: -25 });
  return renderer.render(skin);
}

/** 源图面积 sanity：渲染前防解压炸弹（与 decodePng 的检查互补） */
export function assertRenderableSize(skin: RgbaImage): void {
  if (skin.width * skin.height > LIMITS.maxDerivativeSourceArea) {
    throw new Error(`源图面积 ${skin.width * skin.height} 超过渲染上限`);
  }
}
