// Modal image carousel for the exported viewer.
//
// The chip that opens this lives in the shared annotation tooltip and is owned
// by annotation-links.ts; this module supplies only the modal. The runtime is
// written to be interpolated INSIDE that companion's IIFE, so it defines plain
// functions (openGallery / closeGallery) rather than an IIFE of its own.
//
// The modal mounts on document.body, NOT inside the tooltip: .pc-annotation is
// pointer-events:none and its contents are rewritten on every activation.
//
// BUILD TRAP: template literals in this directory have their backslash escapes
// eaten at build time, so the runtime below contains no regex literals and no
// backslash escapes of any kind -- including in strings. Unicode glyphs are
// written literally.

type AnyAnnotation = {
    extras?: { images?: { src: string, caption: string }[] }
};

// Does any annotation carry a non-empty gallery? Half of the injection gate in
// annotation-links.ts (the other half being "any annotation carries a url").
const hasGallery = (annotations: AnyAnnotation[]): boolean => {
    return (annotations || []).some(a => (a.extras?.images?.length ?? 0) > 0);
};

const galleryRuntime = `
  var galleryLabels = {
    en: { close: 'Close', prev: 'Previous image', next: 'Next image', gallery: 'Image gallery' },
    de: { close: 'Schließen', prev: 'Vorheriges Bild', next: 'Nächstes Bild', gallery: 'Bildergalerie' },
    es: { close: 'Cerrar', prev: 'Imagen anterior', next: 'Imagen siguiente', gallery: 'Galería de imágenes' },
    fr: { close: 'Fermer', prev: 'Image précédente', next: 'Image suivante', gallery: 'Galerie d’images' },
    ja: { close: '閉じる', prev: '前の画像', next: '次の画像', gallery: '画像ギャラリー' },
    ko: { close: '닫기', prev: '이전 이미지', next: '다음 이미지', gallery: '이미지 갤러리' },
    pt: { close: 'Fechar', prev: 'Imagem anterior', next: 'Próxima imagem', gallery: 'Galeria de imagens' },
    ru: { close: 'Закрыть', prev: 'Предыдущее изображение', next: 'Следующее изображение', gallery: 'Галерея изображений' },
    zh: { close: '关闭', prev: '上一张图片', next: '下一张图片', gallery: '图片库' }
  };
  var galleryLang = (navigator.language || 'en').toLowerCase();
  var galleryText = galleryLabels[galleryLang] || galleryLabels[galleryLang.split('-')[0]] || galleryLabels.en;

  // At most one modal at a time; also lets the companion close the gallery when
  // the annotation it belongs to is deactivated.
  var openOverlay = null;
  var openReturnFocus = null;

  function closeGallery() {
    if (!openOverlay) return;
    openOverlay.remove();
    openOverlay = null;
    if (openReturnFocus && openReturnFocus.focus) openReturnFocus.focus();
    openReturnFocus = null;
  }

  function makeButton(cls, glyph, label) {
    var b = document.createElement('button');
    b.className = cls;
    b.textContent = glyph;
    b.setAttribute('aria-label', label);
    return b;
  }

  function openGallery(images, returnFocusEl) {
    closeGallery();
    var index = 0;
    var multiple = images.length > 1;

    var overlay = document.createElement('div');
    overlay.className = 'ss-gallery';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', galleryText.gallery);
    overlay.tabIndex = -1;

    var close = makeButton('ss-gallery-close', '✕', galleryText.close);
    overlay.appendChild(close);

    var counter = null;
    if (multiple) {
      counter = document.createElement('div');
      counter.className = 'ss-gallery-counter';
      overlay.appendChild(counter);
    }

    var frame = document.createElement('div');
    frame.className = 'ss-gallery-frame';
    var img = document.createElement('img');
    img.className = 'ss-gallery-img';
    frame.appendChild(img);

    var prev = null;
    var next = null;
    if (multiple) {
      prev = makeButton('ss-gallery-nav ss-gallery-prev', '‹', galleryText.prev);
      next = makeButton('ss-gallery-nav ss-gallery-next', '›', galleryText.next);
      frame.appendChild(prev);
      frame.appendChild(next);
    }
    overlay.appendChild(frame);

    var caption = document.createElement('div');
    caption.className = 'ss-gallery-caption';
    overlay.appendChild(caption);

    var dots = [];
    if (multiple) {
      var dotRow = document.createElement('div');
      dotRow.className = 'ss-gallery-dots';
      for (var i = 0; i < images.length; i++) {
        var dot = document.createElement('button');
        dot.className = 'ss-gallery-dot';
        dot.setAttribute('aria-label', String(i + 1));
        dotRow.appendChild(dot);
        dots.push(dot);
      }
      overlay.appendChild(dotRow);
    }

    function show(i) {
      index = i;
      var entry = images[i] || {};
      img.src = entry.src || '';
      // caption doubles as alt text; textContent (never innerHTML) because it
      // is user-authored
      img.alt = entry.caption || '';
      caption.textContent = entry.caption || '';
      if (counter) counter.textContent = (i + 1) + ' / ' + images.length;
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === images.length - 1;
      // Disabling the arrow that currently holds focus makes the browser hand
      // focus to document.body, which is outside the overlay. Every key handler
      // is bound to the overlay, so from there the arrow keys would bubble
      // straight to the viewer and drive the camera instead of the carousel.
      // Re-seat focus on the overlay whenever it has escaped.
      var active = document.activeElement;
      if (!active || active.disabled || !overlay.contains(active)) overlay.focus();
      for (var d = 0; d < dots.length; d++) {
        dots[d].className = (d === i) ? 'ss-gallery-dot ss-gallery-dot-on' : 'ss-gallery-dot';
        dots[d].setAttribute('aria-current', (d === i) ? 'true' : 'false');
      }
    }

    function step(delta) {
      var target = index + delta;
      if (target < 0 || target > images.length - 1) return;
      show(target);
    }

    close.addEventListener('click', function (e) { e.stopPropagation(); closeGallery(); });
    if (prev) prev.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
    if (next) next.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
    for (var k = 0; k < dots.length; k++) {
      (function (target) {
        dots[target].addEventListener('click', function (e) { e.stopPropagation(); show(target); });
      })(k);
    }

    // Focus trap. role=dialog + aria-modal=true are advisory only: without
    // this, Tab walks focus out to the viewer behind the modal, and from there
    // Escape and the arrow keys go to the viewer while the modal is still open.
    // The control set varies (a single-image gallery has no arrows, counter or
    // dots) and prev/next go disabled at the ends, so the cycle is recomputed
    // on every Tab from what is actually focusable at that moment.
    function tabbables() {
      var list = [];
      if (!close.disabled) list.push(close);
      if (prev && !prev.disabled) list.push(prev);
      if (next && !next.disabled) list.push(next);
      for (var t = 0; t < dots.length; t++) list.push(dots[t]);
      return list;
    }

    function trapTab(e) {
      if (e.preventDefault) e.preventDefault();
      var items = tabbables();
      if (!items.length) { overlay.focus(); return; }
      // the overlay itself is not in the list, so the first Tab lands on the
      // first control (or the last, for shift+Tab)
      var at = items.indexOf(document.activeElement);
      var delta = e.shiftKey ? -1 : 1;
      var to = (at < 0) ? (e.shiftKey ? items.length - 1 : 0) : ((at + delta + items.length) % items.length);
      items[to].focus();
    }

    // Backdrop click closes; a click on the image or controls must not.
    overlay.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.target === overlay) closeGallery();
    });

    // The viewer drives its camera from document-level input, so every event
    // that starts inside the modal stops here.
    overlay.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { closeGallery(); return; }
      if (e.key === 'Tab') { trapTab(e); return; }
      if (e.key === 'ArrowLeft') { step(-1); return; }
      if (e.key === 'ArrowRight') { step(1); }
    });
    overlay.addEventListener('keyup', function (e) { e.stopPropagation(); });
    overlay.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    overlay.addEventListener('pointerup', function (e) { e.stopPropagation(); });
    overlay.addEventListener('wheel', function (e) { e.stopPropagation(); });
    overlay.addEventListener('contextmenu', function (e) { e.stopPropagation(); });

    show(0);
    document.body.appendChild(overlay);
    openOverlay = overlay;
    openReturnFocus = returnFocusEl || null;
    overlay.focus();
  }
`;

const galleryStyle = `
.ss-gallery {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  background: rgba(0,0,0,0.82);
  pointer-events: auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
.ss-gallery-frame { position: relative; display: flex; align-items: center; justify-content: center; max-width: 90vw; }
.ss-gallery-img { max-width: 88vw; max-height: 70vh; border-radius: 3px; display: block; }
.ss-gallery-caption { color: #e8e8e8; font-size: 14px; line-height: 1.45; text-align: center; max-width: 70ch; }
.ss-gallery-counter { position: absolute; top: 14px; left: 16px; color: #fff; font-size: 13px; opacity: 0.7; }
.ss-gallery-close {
  position: absolute; top: 10px; right: 12px; width: 34px; height: 34px;
  border: none; border-radius: 50%; background: rgba(0,0,0,0.4);
  color: #fff; font-size: 17px; cursor: pointer;
}
.ss-gallery-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 40px; height: 40px; border-radius: 50%;
  background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.25);
  color: #fff; font-size: 20px; line-height: 1; cursor: pointer;
}
.ss-gallery-nav:disabled { opacity: 0.25; cursor: default; }
.ss-gallery-prev { left: -52px; }
.ss-gallery-next { right: -52px; }
.ss-gallery-dots { display: flex; gap: 7px; }
.ss-gallery-dot {
  width: 8px; height: 8px; padding: 0; border: none; border-radius: 50%;
  background: rgba(255,255,255,0.3); cursor: pointer;
}
.ss-gallery-dot-on { background: #fff; }
@media (max-width: 720px) {
  .ss-gallery-prev { left: 6px; }
  .ss-gallery-next { right: 6px; }
  .ss-gallery-img { max-height: 60vh; }
}
`;

export { galleryRuntime, galleryStyle, hasGallery };
