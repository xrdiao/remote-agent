import path from 'node:path';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ASR_DIR, ASR_PYTHON, ASR_MODEL, QWEN_CONFIG } from '../server/voice/config.mjs';

const { values } = parseArgs({ options: { engine: { type: 'string', default: 'sherpa' }, dir: { type: 'string' } } });
if (!['sherpa', 'qwen'].includes(values.engine)) throw new Error('--engine 只能是 sherpa 或 qwen');
const qwen = values.engine === 'qwen';
const directory = path.resolve(values.dir || path.join(ASR_DIR, 'qwen'));
const pythonPath = qwen ? path.join(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : ASR_PYTHON;
const modelPath = qwen ? path.join(directory, 'model') : ASR_MODEL;

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(qwen ? '本机语音：Qwen3-ASR-1.7B + 官方 vLLM 流式接口，需要 Linux / NVIDIA GPU。' : '本机语音：CPU sherpa-onnx + X-ASR 中英混说（160ms 流式模型）。');
console.log(`将创建独立 Python 环境并下载${qwen ? '约 4 GB' : '约 615 MB'}模型及运行依赖到 ${qwen ? directory : ASR_DIR}。`);
console.log('仅安装时访问 PyPI / Hugging Face；识别在本机执行，不上传音频到识别服务。需要已安装 Python 3.10 或以上。');
const answer = await rl.question('同意安装和下载？[y/N] ');
rl.close();
if (!/^y(es)?$/i.test(answer.trim())) process.exit(0);
const run = (cmd, args) => new Promise((resolve, reject) => {
  const env = { ...process.env };
  if (qwen) { delete env.PYTHONPATH; delete env.PYTHONHOME; env.PYTHONNOUSERSITE = '1'; }
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} 退出：${code}`)));
});
try {
  const python = process.env.ASR_SETUP_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  if (qwen && process.platform !== 'linux') throw new Error('Qwen 官方 vLLM 安装入口目前需要 Linux；本平台请继续使用 CPU Sherpa');
  await run(python, [...(process.platform === 'win32' && !process.env.ASR_SETUP_PYTHON ? ['-3'] : []), '-m', 'venv', qwen ? path.join(directory, 'venv') : path.join(ASR_DIR, 'venv')]);
  await run(pythonPath, ['-m', 'pip', 'install', ...(qwen ? ['qwen-asr[vllm]==0.0.6'] : ['sherpa-onnx==1.13.8', 'numpy>=1.26,<3'])]);
  if (qwen) await run(pythonPath, ['-c', 'import torch; from qwen_asr import Qwen3ASRModel; assert torch.cuda.is_available(), "Qwen 流式识别需要可用的 NVIDIA GPU"']);
  await run(pythonPath, [fileURLToPath(new URL('voice-download.py', import.meta.url)), modelPath, values.engine]);
  if (qwen) {
    const { files } = JSON.parse(fs.readFileSync(path.join(modelPath, 'source.json'), 'utf8'));
    fs.mkdirSync(ASR_DIR, { recursive: true });
    fs.writeFileSync(QWEN_CONFIG, JSON.stringify({ python: pythonPath, model: modelPath, files }, null, 2) + '\n');
  }
  console.log('安装完成。手机菜单打开“语音输入”，按住麦克风说话；首次使用需加载模型。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
