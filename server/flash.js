'use strict';
// ForgeDeck — 烧录/构建命令构造（多后端，参数全部走数组，不经 shell）
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fail, resolveIn } = require('./util');

const BACKENDS = [
  { id: 'platformio', name: 'PlatformIO', bins: ['pio'], note: 'ESP32/STM32/AVR/… 一把梭' },
  { id: 'esptool', name: 'esptool.py', bins: ['esptool.py', 'esptool'], note: 'ESP 系列晶片直烧' },
  { id: 'avrdude', name: 'avrdude', bins: ['avrdude'], note: 'AVR/Arduino 直烧' },
  { id: 'stflash', name: 'st-flash', bins: ['st-flash'], note: 'STM32 ST-Link 直烧' },
  { id: 'dfu', name: 'dfu-util', bins: ['dfu-util'], note: 'DFU 引导区烧录' },
  { id: 'openocd', name: 'OpenOCD', bins: ['openocd'], note: 'JTAG/SWD + GDB' },
  { id: 'arduino', name: 'arduino-cli', bins: ['arduino-cli'], note: 'Arduino 草图编译烧录' },
  { id: 'picotool', name: 'picotool', bins: ['picotool'], note: 'RP2040 BOOTSEL' },
  { id: 'make', name: 'make', bins: ['make'], note: 'Makefile 目标' },
];

function which(bin) {
  if (!bin) return '';
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : '';
  const r = spawnSync('which', [bin], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

function backendStatus(cfg) {
  const out = [];
  for (const b of BACKENDS) {
    let hit = '';
    for (const bin of b.bins) {
      // 配置里可覆盖路径
      const custom = bin === 'pio' ? cfg.tools.pio
        : bin.startsWith('esptool') ? cfg.tools.esptool
        : bin === 'avrdude' ? cfg.tools.avrdude
        : bin === 'st-flash' ? cfg.tools.stflash
        : bin === 'dfu-util' ? cfg.tools.dfuUtil
        : bin === 'openocd' ? cfg.tools.openocd
        : '';
      hit = which(custom || bin);
      if (hit) break;
    }
    out.push({ id: b.id, name: b.name, note: b.note, path: hit, available: !!hit });
  }
  return out;
}

function pioPath(cfg) {
  const p = which(cfg.tools.pio);
  if (!p) fail(400, 'PlatformIO 未安装：pip install platformio，或在 config.json 的 tools.pio 指定绝对路径');
  return p;
}

function pickBackend(cfg, want, projectDir) {
  if (want && want !== 'auto') return want;
  if (projectDir && fs.existsSync(path.join(projectDir, 'platformio.ini'))) return 'platformio';
  if (projectDir && fs.readdirSync(projectDir).some((f) => f.endsWith('.ino'))) return 'arduino';
  if (projectDir && (fs.existsSync(path.join(projectDir, 'Makefile')) || fs.existsSync(path.join(projectDir, 'makefile')))) return 'make';
  return 'platformio';
}

function assertPort(port) {
  if (!port) return '';
  const p = String(port);
  if (!/^\/dev\/[A-Za-z0-9_./-]+$/.test(p)) fail(400, '端口路径非法');
  if (!fs.existsSync(p)) fail(400, `端口不存在: ${p}`);
  return p;
}

function assertFileWithIn(root, file, label) {
  if (!file) fail(400, `${label} 未指定`);
  const abs = resolveIn(root, file);
  if (!abs || !fs.existsSync(abs)) fail(400, `${label} 不存在或越界: ${file}`);
  return abs;
}

// 返回 { cmd, args, cwd, note }
function buildCommand(cfg, opts) {
  const { kind, project, env, port, backend, file, address, target } = opts;
  const root = cfg.workspaceRealPath;
  const cwd = project ? assertFileWithIn(root, project, '项目目录') : root;
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(400, '项目目录无效');
  const be = pickBackend(cfg, backend, cwd);
  const P = assertPort(port);

  if (kind === 'build' || kind === 'clean' || kind === 'flash' || kind === 'erase') {
    if (be === 'platformio') {
      const pio = pioPath(cfg);
      const args = ['run', '-d', cwd];
      if (env) args.push('-e', env);
      if (kind === 'clean') args.push('-t', 'clean');
      else if (kind === 'erase') args.push('-t', 'erase');
      else if (kind === 'flash') {
        args.push('-t', 'upload');
        if (P) args.push('--upload-port', P);
      } else args.push('-t', 'build');
      const note = `PlatformIO ${kind}${env ? ' env=' + env : ''}${P ? ' port=' + P : ''}`;
      return { cmd: pio, args, cwd, note };
    }
    if (be === 'arduino') {
      const cli = which('arduino-cli') || 'arduino-cli';
      if (kind === 'build' || kind === 'clean') {
        return { cmd: cli, args: ['compile', '--build-path', path.join(cwd, '.arduino-build'), cwd], cwd, note: 'arduino-cli compile' };
      }
      if (!P) fail(400, 'arduino-cli 烧录需要选择串口');
      const args = ['upload', '-p', P];
      if (env) args.push('--fqbn', env);
      args.push(cwd);
      return { cmd: cli, args, cwd, note: 'arduino-cli upload' };
    }
    if (be === 'make') {
      const mk = which('make') || 'make';
      const t = kind === 'flash' ? (target || 'flash') : kind === 'clean' ? 'clean' : (target || 'all');
      return { cmd: mk, args: [t], cwd, note: `make ${t}` };
    }
    if (be === 'esptool') {
      const tool = which(cfg.tools.esptool) || which('esptool.py') || which('esptool');
      if (!tool) fail(400, 'esptool 未找到：pip install esptool');
      if (kind === 'erase') {
        if (!P) fail(400, 'erase 需要串口');
        return { cmd: tool, args: ['--port', P, 'erase_flash'], cwd, note: 'esptool erase_flash' };
      }
      const bin = assertFileWithIn(root, file, '固件文件');
      if (!P) fail(400, '烧录需要串口');
      return {
        cmd: tool,
        args: ['--port', P, '--baud', String(opts.baud || 460800), 'write_flash', '-f', String(address || '0x0'), bin],
        cwd,
        note: `esptool write_flash ${address || '0x0'}`,
      };
    }
    if (be === 'avrdude') {
      const tool = which(cfg.tools.avrdude) || 'avrdude';
      if (kind === 'erase') return { cmd: tool, args: ['-c', 'arduino', '-p', env || 'm328p', '-P', P || '', '-e'].filter(Boolean), cwd, note: 'avrdude chip erase' };
      const bin = assertFileWithIn(root, file, 'HEX 文件');
      if (!P) fail(400, 'avrdude 需要串口');
      return {
        cmd: tool,
        args: ['-c', 'arduino', '-p', env || 'm328p', '-P', P, '-b', String(opts.baud || 115200), '-U', `flash:w:${bin}:i`],
        cwd,
        note: 'avrdude flash',
      };
    }
    if (be === 'stflash') {
      const tool = which(cfg.tools.stflash) || 'st-flash';
      const bin = assertFileWithIn(root, file, '固件文件');
      return { cmd: tool, args: ['--reset', 'write', bin, String(address || '0x08000000')], cwd, note: 'st-flash write' };
    }
    if (be === 'dfu') {
      const tool = which(cfg.tools.dfuUtil) || 'dfu-util';
      const bin = assertFileWithIn(root, file, '固件文件');
      return { cmd: tool, args: ['-a', '0', '-s', `${address || '0x08000000'}:leave`, '-D', bin], cwd, note: 'dfu-util download' };
    }
    if (be === 'openocd') {
      const tool = which(cfg.tools.openocd) || 'openocd';
      const bin = assertFileWithIn(root, file, '固件文件');
      if (!opts.cfgFile) fail(400, 'OpenOCD 需要指定 cfgFile（如 board/stm32f4discovery.cfg）');
      return { cmd: tool, args: ['-f', String(opts.cfgFile), '-c', `program ${bin} ${address || '0x08000000'} verify reset exit`], cwd, note: 'openocd program' };
    }
    if (be === 'picotool') {
      const tool = which('picotool') || 'picotool';
      const bin = assertFileWithIn(root, file, 'UF2/BIN 文件');
      return { cmd: tool, args: ['load', bin], cwd, note: 'picotool load' };
    }
    fail(400, `后端 ${be} 不支持 ${kind}`);
  }

  if (kind === 'custom') {
    // 仅在 workspace 内运行任意外部命令时，必须显式给出 argv 数组
    const argv = Array.isArray(opts.argv) ? opts.argv : null;
    if (!argv || !argv.length) fail(400, 'custom 需要 argv 数组');
    if (!/^[A-Za-z0-9_./+-]+$/.test(argv[0])) fail(400, '命令名非法');
    return { cmd: argv[0], args: argv.slice(1), cwd, note: 'custom' };
  }

  fail(400, `不支持的任务类型: ${kind}`);
}

module.exports = { buildCommand, backendStatus, which, BACKENDS };
