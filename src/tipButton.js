/**
 * Tip button in the control bar: opens the creator's tip page on 3speak.tv
 * (HIVE / HBD or Lightning) in a popup, because an embedded player can't sign a
 * transfer or pay an invoice itself. The page closes itself once the tip is
 * sent. Where popups don't exist or are blocked (phones, some host sites) it is
 * an ordinary link to the same page.
 *
 * Only for finished videos and shorts: not for live streams (Supporters counts
 * videos only) or placeholders still encoding.
 *
 * `?tip=preview` points it at preview.3speak.tv for testing; no other host can
 * be chosen, so an embed can't send viewers to a look-alike tip page.
 */

const POPUP_W = 440;
const POPUP_H = 720;

let tipEl = null;

function tipHost() {
  const params = new URLSearchParams(window.location.search);
  return params.get('tip') === 'preview' ? 'https://preview.3speak.tv' : 'https://3speak.tv';
}

function createTipButton(player) {
  const controlBar = player.controlBar.el();

  tipEl = document.createElement('a');
  tipEl.className = 'vjs-control vjs-button vjs-tip-button';
  tipEl.setAttribute('target', '_blank');
  tipEl.setAttribute('rel', 'noopener');
  tipEl.setAttribute('aria-label', 'Tip the creator');
  tipEl.setAttribute('title', 'Tip the creator');
  // 3speak.tv's gift icon (lucide "gift"), the one its own Tip buttons use.
  tipEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"/><path d="M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5"/><rect x="3" y="7" width="18" height="4" rx="1"/></svg>';

  tipEl.addEventListener('click', function(e) {
    e.stopPropagation();
    if (!player.paused()) player.pause();
    if (player.isFullscreen()) player.exitFullscreen();
    const left = Math.max(0, Math.round((window.screen.width - POPUP_W) / 2));
    const top = Math.max(0, Math.round((window.screen.height - POPUP_H) / 2));
    const win = window.open(tipEl.href, '3speak-tip', `popup,width=${POPUP_W},height=${POPUP_H},left=${left},top=${top}`);
    if (win) e.preventDefault();
  });

  // Same spot as the CC button: just before fullscreen.
  const fsButton = controlBar.querySelector('.vjs-fullscreen-control');
  if (fsButton) {
    controlBar.insertBefore(tipEl, fsButton);
  } else {
    controlBar.appendChild(tipEl);
  }
}

/** Show the button for this video, or hide it when the video can't be tipped. */
export function setTipVideo(player, videoData) {
  const tippable = !!(videoData && videoData.owner && videoData.permlink
    && !videoData.isPlaceholder
    && (videoData.type === 'embed' || videoData.type === 'legacy'));
  if (!tippable) {
    if (tipEl) tipEl.style.display = 'none';
    return;
  }
  if (!tipEl) createTipButton(player);
  // A short links by its asset id (/shorts?v=); a video by its Hive post, which
  // an embed asset may not share its permlink with.
  const isShort = videoData.short === true;
  const permlink = isShort ? videoData.permlink : (videoData.hivePermlink || videoData.permlink);
  tipEl.href = `${tipHost()}/tip/@${encodeURIComponent(videoData.owner)}/${encodeURIComponent(permlink)}?kind=${isShort ? 'short' : 'video'}`;
  tipEl.style.display = '';
}
