// The Assets hold images and videos; videos are shown with <video> wherever images use <img>.
// Keep these extensions in step with images.rs.
export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm']
export const ASSET_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', ...VIDEO_EXTS]

export const isVideo = (path: string) => VIDEO_EXTS.includes(path.slice(path.lastIndexOf('.') + 1).toLowerCase())

// A video's first frame as a still preview (for tiles), muted and without controls.
export function videoPreview(src: string): HTMLVideoElement {
  // "#t=0.1" makes the webview fetch and show a frame instead of a blank box.
  return Object.assign(document.createElement('video'), { src: `${src}#t=0.1`, muted: true, preload: 'metadata', playsInline: true })
}
