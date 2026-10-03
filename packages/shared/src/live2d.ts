import { imuncleLive2DModels } from './live2d-catalog.ts';

export interface Live2DModelInfo {
  id: string;
  name: string;
  url: string;
  version: 2 | 4;
  builtin: boolean;
  sizeBytes: number;
}

export interface Live2DDisplay {
  enabled: boolean;
  modelId: string;
  model: Live2DModelInfo | null;
}

export const builtinLive2DModels: Live2DModelInfo[] = [{
  id: 'aoba',
  name: 'Suzukaze Aoba',
  url: '/live2d/models/Suzukaze-Aoba/Aoba.json',
  version: 2,
  builtin: true,
  sizeBytes: 0,
}, ...imuncleLive2DModels];
