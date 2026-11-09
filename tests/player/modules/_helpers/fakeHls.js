// A controllable stand-in for hls.js. Use from a vi.mock('hls.js') factory.
import { vi } from 'vitest';

export class FakeHls {
  static supported = true;
  static instances = [];
  static Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
  static isSupported() { return FakeHls.supported; }
  static reset() { FakeHls.supported = true; FakeHls.instances = []; }

  constructor(config) {
    this.config = config;
    this.handlers = {};
    this.loadSource = vi.fn();
    this.attachMedia = vi.fn();
    this.destroy = vi.fn();
    FakeHls.instances.push(this);
  }

  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, data) { (this.handlers[ev] || []).forEach((fn) => fn(ev, data)); }
}
