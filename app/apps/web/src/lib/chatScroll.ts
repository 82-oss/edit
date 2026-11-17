import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";

/**
 * A chat's scroll that keeps to the newest line, as a good chat app does
 * (Sphe, Nov 17: after sending he saw only his own message and had to scroll
 * to see the agent thinking). The shell used to scroll down only when it drew
 * again itself, but the thinking line, a running tool, the streamed words and
 * an animation's growing height all change below it without that, so they
 * landed under the fold. Here the content's size is watched instead: whenever
 * it (or the scroller) changes size while pinned, the scroll goes to the
 * bottom, before paint. Scrolling up lets go; coming back near the bottom, or
 * sending, takes hold again.
 */

/** How near the bottom counts as at it (px). */
export const NEAR_BOTTOM = 64;

/** The shell's "take me to the bottom": the composer calls it as it sends. */
export const PinChat = createContext<(() => void) | null>(null);

export const usePinChat = () => useContext(PinChat);

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useStickToBottom(resetKey?: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // stick: following the bottom. smooth: a send's glide is still on its way (growth until then glides too).
  // last: the scroll position last seen, so a move up (the person's) tells from content growing under a still view.
  const state = useRef({ stick: true, smooth: false, last: 0 });

  const follow = useCallback(() => {
    const node = scroller.current;
    const now = state.current;
    if (node === null || !now.stick) return;
    const bottom = node.scrollHeight - node.clientHeight;
    if (bottom - node.scrollTop < 1) {
      now.smooth = false;
      now.last = node.scrollTop;
      return;
    }
    if (now.smooth) node.scrollTo({ top: bottom, behavior: "smooth" });
    else node.scrollTop = bottom;
    now.last = node.scrollTop;
  }, []);

  const pin = useCallback(() => {
    state.current.stick = true;
    state.current.smooth = !reducedMotion();
    follow();
  }, [follow]);

  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (node === null) return;
    const now = state.current;
    const top = node.scrollTop;
    const distance = node.scrollHeight - node.clientHeight - top;
    if (top < now.last - 1 && distance >= 1) {
      // Moved up, and not by content shrinking under it (that leaves it at the bottom): the person is reading back.
      now.stick = false;
      now.smooth = false;
    } else if (distance <= NEAR_BOTTOM && top >= now.last) {
      now.stick = true;
      if (distance < 1) now.smooth = false;
    }
    now.last = top;
  }, []);

  // A wheel turned up lets go at once, before the next growth could pull the view back under the person's hand.
  const onWheel = useCallback((event: { deltaY: number }) => {
    const node = scroller.current;
    if (event.deltaY < 0 && node !== null && node.scrollHeight > node.clientHeight) {
      state.current.stick = false;
      state.current.smooth = false;
    }
  }, []);

  // Opening a chat (or another one) lands at its bottom, at once.
  useLayoutEffect(() => {
    state.current.stick = true;
    state.current.smooth = false;
    follow();
  }, [resetKey, follow]);

  // Anything below changing size: new rows, streamed words, an image loading, an animation, the composer growing.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => follow());
    if (scroller.current !== null) observer.observe(scroller.current);
    if (content.current !== null) observer.observe(content.current);
    return () => observer.disconnect();
  }, [follow]);

  return { scroller, content, pin, onScroll, onWheel };
}
