import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from '../../lib/auth.mjs';

export const ASR_DIR = path.join(DATA_DIR, 'asr');
export const ASR_PYTHON = path.join(ASR_DIR, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const ASR_MODEL = path.join(ASR_DIR, 'x-asr-160ms');
export const ASR_FILES = ['encoder-160ms.onnx', 'decoder-160ms.onnx', 'joiner-160ms.onnx', 'tokens.txt'];
export const QWEN_CONFIG = path.join(ASR_DIR, 'qwen.json');
export function voiceEngines() {
  const engines = [{ id: 'sherpa', label: 'Sherpa · X-ASR', detail: '中英混说 · CPU', python: ASR_PYTHON, model: ASR_MODEL, files: ASR_FILES, script: 'worker.py' }];
  if (fs.existsSync(QWEN_CONFIG)) {
    const config = JSON.parse(fs.readFileSync(QWEN_CONFIG, 'utf8'));
    engines.push({ id: 'qwen', label: 'Qwen3-ASR-1.7B', detail: '中英混说 · vLLM / GPU', ...config, script: 'qwen-worker.py' });
  }
  return engines.filter(engine => fs.existsSync(engine.python) && engine.files.every(name => fs.existsSync(path.join(engine.model, name))));
}
