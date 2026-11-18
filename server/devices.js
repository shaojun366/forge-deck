'use strict';
// ForgeDeck — 设备发现：串口、烧录器、USB 描述、调试探针
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERIAL_RE = /^(?:ttyUSB|ttyACM|ttyAMA|ttyCH343USB|ttyCH341USB|ttyS\d+)\d*$/;

// 已知 USB VID:PID -> 板卡/调试器
const KNOWN = [
    { id: '0483:3748', name: 'ST-Link V2', kind: 'debugger', tool: 'stflash' },
  { id: '0483:374b', name: 'ST-Link V3', kind: 'debugger', tool: 'stflash' },
  { id: '0483:374d', name: 'ST-Link V3.1', kind: 'debugger', tool: 'stflash' },
  { id: '0483:374e', name: 'ST-Link V3.2', kind: 'debugger', tool: 'stflash' },
  { id: '0483:3752', name: 'ST-Link V2-1', kind: 'debugger', tool: 'stflash' },
  { id: '0483:5740', name: 'STM32 虚拟串口 (VCP)', kind: 'serial' },
  { id: '1a86:7523', name: 'CH340 串口', kind: 'serial', chips: ['ESP32', 'Arduino'] },
  { id: '1a86:55d4', name: 'CH343 串口', kind: 'serial', chips: ['ESP32-S3'] },
  { id: '10c4:ea60', name: 'CP210x 串口', kind: 'serial', chips: ['ESP32', 'ESP8266'] },
  { id: '10c4:ea70', name: 'CP2105 双串口', kind: 'serial' },
  { id: '0403:6001', name: 'FTDI FT232', kind: 'serial' },
  { id: '0403:6015', name: 'FTDI FT231X', kind: 'serial' },
  { id: '303a:1001', name: 'ESP32-S3 原生 USB', kind: 'board', chips: ['ESP32-S3'], tool: 'esptool' },
  { id: '303a:0002', name: 'ESP32-S2 原生 USB', kind: 'board', chips: ['ESP32-S2'], tool: 'esptool' },
  { id: '303a:0009', name: 'ESP32-C3 原生 USB', kind: 'board', chips: ['ESP32-C3'], tool: 'esptool' },
  { id: '303a:1002', name: 'ESP32-C3/C6 USB-JTAG', kind: 'board', chips: ['ESP32-C3', 'ESP32-C6'], tool: 'esptool' },
  { id: '2341:0043', name: 'Arduino Uno R3', kind: 'board', chips: ['ATmega328P'], tool: 'avrdude' },
  { id: '2341:0001', name: 'Arduino Uno', kind: 'board', chips: ['ATmega328P'], tool: 'avrdude' },
  { id: '2e8a:0003', name: 'Raspberry Pi Pico', kind: 'board', chips: ['RP2040'], tool: 'picotool' },
  { id: '2e8a:0005', name: 'Pico (BOOTSEL)', kind: 'bootloader', chips: ['RP2040'], tool: 'picotool' },
  { id: '1366:0101', name: 'SEGGER J-Link', kind: 'debugger', tool: 'openocd' },
  { id: '1366:0105', name: 'J-Link OB', kind: 'debugger', tool: 'openocd' },
  { id: '1d50:6018', name: 'Black Magic Probe', kind: 'debugger', tool: 'gdb' },
  { id: '1d50:614e', name: 'Black Magic Probe (DFU)', kind: 'debugger', tool: 'gdb' },
  { id: '03eb:2ff4', name: 'Atmel DFU 引导区', kind: 'bootloader', tool: 'dfu-util' },
  { id: '03eb:2fe4', name: 'Atmel DFU', kind: 'bootloader', tool: 'dfu-util' },
  { id: '0483:df11', name: 'STM32 DFU 引导区', kind: 'bootloader', tool: 'dfu-util' },
  { id: '239a:0001', name: 'Adafruit/UF2 引导区', kind: 'bootloader', tool: 'uf2' },
  { id: '1209:0001', name: 'UF2 引导区', kind: 'bootloader', tool: 'uf2' },
];

function readDirSafe(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

function sysfsInfo(devName) {
  const base = path.join('/sys/class/tty', devName);
  const out = {};
  try {
    out.vid = fs.readFileSync(path.join(base, 'device/../idVendor'), 'utf8').trim();
    out.pid = fs.readFileSync(path.join(base, 'device/../idProduct'), 'utf8').trim();
  } catch {}
  try {
    out.product = fs.readFileSync(path.join(base, 'device/../product'), 'utf8').trim();
  } catch {}
  try {
    out.manufacturer = fs.readFileSync(path.join(base, 'device/../manufacturer'), 'utf8').trim();
  } catch {}
  try {
    out.serial = fs.readFileSync(path.join(base, 'device/../serial'), 'utf8').trim();
  } catch {}
  if (out.vid && out.pid) out.usbId = `${out.vid}:${out.pid}`;
  return out;
}

function serialPorts() {
  const ports = [];
  const devNames = readDirSafe('/dev').filter((n) => /^(ttyUSB|ttyACM|ttyAMA|ttyCH343USB|ttyCH341USB)\d+$/.test(n));
  const byIdDir = '/dev/serial/by-id';
  const byId = new Map();
  for (const link of readDirSafe(byIdDir)) {
    try {
      const real = fs.realpathSync(path.join(byIdDir, link));
      byId.set(real, link);
    } catch {}
  }
  for (const name of devNames) {
    const dev = path.join('/dev', name);
    const info = sysfsInfo(name);
    const known = info.usbId ? KNOWN.find((k) => k.id === info.usbId) : null;
    ports.push({
      device: dev,
      name,
      byId: byId.get(dev) || '',
      usbId: info.usbId || '',
      label: info.product || (known && known.name) || name,
      manufacturer: info.manufacturer || '',
      serial: info.serial || '',
      chips: known && known.chips ? known.chips : [],
    });
  }
  return ports;
}

function lsusbList() {
  const r = spawnSync('lsusb', [], { encoding: 'utf8', timeout: 4000 });
  if (r.error || r.status !== 0) return { error: r.error?.message || r.stderr?.trim() || 'lsusb unavailable', lines: [] };
  return { error: '', lines: r.stdout.split('\n').filter(Boolean) };
}

function usbDevices() {
  const l = lsusbList();
  const found = [];
  for (const line of l.lines) {
    const m = line.match(/ID ([0-9a-f]{4}:[0-9a-f]{4})\s*(.*)$/i);
    if (!m) continue;
    const id = m[1].toLowerCase();
    const known = KNOWN.find((k) => k.id === id);
    found.push({
      id,
      desc: m[2] || '',
      known: known ? known.name : '',
      kind: known ? known.kind : 'other',
      tool: known ? known.tool || '' : '',
      line,
    });
  }
  return { error: l.error, lines: l.lines, devices: found };
}

function serialAccessHint() {
  const uid = process.getuid ? process.getuid() : -1;
  if (uid === 0) return '';
  const groups = readDirSafe('/dev').length ? spawnSync('id', ['-nG'], { encoding: 'utf8' }) : null;
  const g = groups && groups.stdout ? groups.stdout.trim().split(/\s+/) : [];
  if (!g.includes('dialout') && !g.includes('uucp')) {
    return '当前进程用户不在 dialout/uucp 组，可能打不开串口：sudo usermod -aG dialout $USER && 重新登录';
  }
  return '';
}

function detect(cfg) {
  const ports = serialPorts();
  const usb = usbDevices();
  const out = {
    at: new Date().toISOString(),
    serialPorts: ports,
    usb: usb.devices,
    usbRaw: usb.lines,
    errors: usb.error ? [`lsusb: ${usb.error}`] : [],
    hint: serialAccessHint(),
    boards: [],
  };
  // 汇总可直接烧录的目标
  const seen = new Set();
  for (const p of ports) {
    const key = p.usbId || p.device;
    if (seen.has(key)) continue;
    seen.add(key);
    out.boards.push({
      port: p.device,
      label: p.label,
      chips: p.chips,
      usbId: p.usbId,
      flashable: true,
      via: 'serial',
    });
  }
  for (const d of usb.devices) {
    if (d.kind === 'board' || d.kind === 'bootloader' || d.kind === 'debugger') {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      out.boards.push({
        port: '',
        label: d.known || d.desc,
        chips: (KNOWN.find((k) => k.id === d.id) || {}).chips || [],
        usbId: d.id,
        flashable: d.kind !== 'debugger',
        via: d.kind,
        tool: d.tool,
      });
    }
  }
  return out;
}

function isAllowedPort(cfg, dev) {
  const allow = (cfg.serial && cfg.serial.allowPorts) || [];
  if (!allow.length) return true;
  return allow.includes(dev);
}

module.exports = { detect, serialPorts, usbDevices, isAllowedPort, KNOWN, SERIAL_RE };
