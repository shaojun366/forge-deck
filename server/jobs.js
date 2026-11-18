'use strict';
// ForgeDeck — 任务系统：编译/烧录/擦除/自定义命令，带日志缓冲与多订阅者
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { stamp } = require('./util');

const MAX_LINES = 4000;
const MAX_LINE_LEN = 4000;

class Job {
  constructor({ kind, title, cmd, args, cwd, env, meta }) {
    this.id = crypto.randomUUID().slice(0, 8);
    this.kind = kind;
    this.title = title || kind;
    this.cmd = cmd;
    this.args = args || [];
    this.cwd = cwd;
    this.env = env || null;
    this.meta = meta || {};
    this.status = 'queued'; // queued | running | done | failed | canceled
    this.code = null;
    this.startedAt = null;
    this.endedAt = null;
    this.log = [];
    this.proc = null;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50);
    this.truncated = 0;
  }

  summary() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      status: this.status,
      code: this.code,
      cwd: this.cwd,
      cmd: this.cmd,
      args: this.args,
      meta: this.meta,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lines: this.log.length,
      truncated: this.truncated,
    };
  }

  text() {
    return this.log.join('');
  }

  push(chunk, stream = 'out') {
    const raw = String(chunk).replace(/\r\n/g, '\n');
    const parts = raw.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i];
      const line = piece.length > MAX_LINE_LEN ? piece.slice(0, MAX_LINE_LEN) + ' …[截断]' : piece;
      const eol = i === parts.length - 1 ? '' : '\n';
      this.log.push(line + eol);
    }
    while (this.log.length > MAX_LINES) { this.log.shift(); this.truncated++; }
    this.emitter.emit('data', { text: String(chunk), stream });
  }

  note(text) {
    this.push(`[${stamp()}] ${text}\n`, 'sys');
  }

  start() {
    this.status = 'running';
    this.startedAt = new Date().toISOString();
    this.note(`执行: ${[this.cmd, ...this.args].join(' ')}`);
    let proc;
    try {
      proc = spawn(this.cmd, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...(this.env || {}), TERM: 'dumb', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.note(`启动失败: ${e.message}`);
      this.finish(-1, 'failed');
      return this;
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => this.push(d, 'out'));
    proc.stderr.on('data', (d) => this.push(d, 'err'));
    proc.on('error', (e) => this.note(`进程错误: ${e.message}`));
    proc.on('close', (code, signal) => {
      this.finish(code, signal === 'SIGTERM' ? 'canceled' : code === 0 ? 'done' : 'failed');
    });
    return this;
  }

  finish(code, status) {
    if (this.status === 'done' || this.status === 'failed' || this.status === 'canceled') return;
    this.status = status || (code === 0 ? 'done' : 'failed');
    this.code = code;
    this.endedAt = new Date().toISOString();
    const sec = this.startedAt ? ((Date.now() - Date.parse(this.startedAt)) / 1000).toFixed(1) : '?';
    this.note(`结束: ${this.status} code=${code} 用时 ${sec}s`);
    this.emitter.emit('end', this.summary());
  }

  cancel() {
    if (!this.proc) return false;
    try { this.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { this.proc && this.proc.kill('SIGKILL'); } catch {} }, 4000);
    this.status = 'canceled';
    return true;
  }
}

class JobManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.jobs = new Map();
    this.keep = (cfg.limits && cfg.limits.jobsKeep) || 30;
  }

  create(opts) {
    const job = new Job(opts);
    this.jobs.set(job.id, job);
    job.start();
    this._prune();
    return job;
  }

  get(id) {
    return this.jobs.get(String(id)) || null;
  }

  list() {
    return [...this.jobs.values()].map((j) => j.summary()).reverse();
  }

  _prune() {
    if (this.jobs.size <= this.keep) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.keep) break;
      if (job.status !== 'running') this.jobs.delete(id);
    }
  }
}

module.exports = { JobManager, Job };
