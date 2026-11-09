// Import this FIRST in every main.js test file: it mocks every dependency
// main.js pulls in, backed by the fakes in ./fakes.js.
import { vi } from 'vitest';

vi.mock('video.js', async () => (await import('./fakes.js')).modules.videojs());
vi.mock('videojs-contrib-quality-levels', async () => (await import('./fakes.js')).modules.plugin());
vi.mock('videojs-hls-quality-selector', async () => (await import('./fakes.js')).modules.plugin());
vi.mock('hls.js', async () => (await import('./fakes.js')).modules.hls());
vi.mock('../../../../src/adBreak.js', async () => (await import('./fakes.js')).modules.adBreak());
vi.mock('../../../../src/scrubPreview.js', async () => (await import('./fakes.js')).modules.scrubPreview());
vi.mock('../../../../src/heatmapBar.js', async () => (await import('./fakes.js')).modules.heatmap());
vi.mock('../../../../src/timelineUI.js', async () => (await import('./fakes.js')).modules.timelineUI());
vi.mock('../../../../src/tipButton.js', async () => (await import('./fakes.js')).modules.tipButton());
vi.mock('../../../../src/captionUI.js', async () => (await import('./fakes.js')).modules.captionUI());
vi.mock('../../../../src/subtitleManager.js', async () => (await import('./fakes.js')).modules.subtitleManager());
vi.mock('../../../../src/live.js', async () => (await import('./fakes.js')).modules.live());
