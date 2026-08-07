import { MARKER_SIZE, MARKER_TOOLTIPS, markerHitTest, markerInteractive, markerScale, markerVisible, portalsForScene, resolveMarkerTooltip } from '../portal-marker';

// Portal icons for the exported viewer.
//
// One quad per portal, lying flat IN the portal's plane, at the portal centre
// (the point the editor's transform gizmo sits on), at a constant 48px screen
// size. The quad lives in a layer inserted right after World OPAQUE -- i.e.
// BEFORE the splats, which render in World transparent -- so a splat in front
// of the portal simply paints over the icon. That is where the occlusion
// comes from; there is no depth readback and, unlike the viewer's annotation
// hotspots, no always-on-top second copy, so an occluded icon disappears
// instead of ghosting.
//
// The runtime below is written to be interpolated INSIDE the portals
// companion's IIFE (viewer-companion/portals.ts), so it defines plain functions
// rather than an IIFE of its own and reads that closure's `data`, `activeIndex`,
// `liveApp`, `transState` and `getState()`.
//
// BUILD TRAP: template literals in this directory have their backslash escapes
// eaten at build time, so the runtime below contains no backslashes of any kind
// -- no regex escapes, no newline escapes in strings. The multi-line shader
// chunks are therefore written on one line. No backticks either: this string is
// spliced into another template literal.

const markerStyle = `
.ss-portal-markers { position: fixed; inset: 0; z-index: 1998; pointer-events: none; }
.ss-portal-marker-tip {
  position: absolute; display: block; box-sizing: border-box;
  width: fit-content; max-width: 220px; padding: 8px;
  border-radius: 4px; background: rgba(0, 0, 0, 0.8); color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; word-wrap: break-word; white-space: normal;
  pointer-events: none; opacity: 0; visibility: hidden;
  transition: opacity 200ms ease-in-out;
}
.ss-portal-marker-tip.on { opacity: 1; visibility: visible; }
.ss-portal-marker-tip.arrow-right::before,
.ss-portal-marker-tip.arrow-left::before {
  content: ""; position: absolute; top: var(--ss-tip-arrow, 50%);
  transform: translateY(-50%);
  border-top: 8px solid transparent; border-bottom: 8px solid transparent;
}
.ss-portal-marker-tip.arrow-right::before { left: -8px; border-right: 8px solid rgba(0, 0, 0, 0.8); }
.ss-portal-marker-tip.arrow-left::before { right: -8px; border-left: 8px solid rgba(0, 0, 0, 0.8); }
`;

const markerRuntime = `
  var markerTooltips = ${JSON.stringify(MARKER_TOOLTIPS)};
  var portalsForScene = ${portalsForScene.toString()};
  var markerScale = ${markerScale.toString()};
  var markerVisible = ${markerVisible.toString()};
  var markerInteractive = ${markerInteractive.toString()};
  var markerHitTest = ${markerHitTest.toString()};
  var resolveMarkerTooltip = ${resolveMarkerTooltip.toString()};

  var MARKER_SIZE = ${MARKER_SIZE};
  // The viewer treats a pointerup as a click when accumulated movement stayed
  // under TAP_EPSILON = 15. Matching it here means "the viewer would have
  // navigated" and "the marker shows its tooltip" cannot disagree on whether
  // the gesture was a click; a smaller value left a dead zone where the
  // movement was suppressed and nothing opened. Both reads now hit-test the
  // pointer-DOWN position (see the pointerup listener below), so the two
  // metrics can never disagree about WHICH icon a click landed on -- they
  // still differ in kind, straight-line displacement here versus accumulated
  // path there, so they can still disagree about whether the gesture counts
  // as a click at all.
  var MARKER_CLICK_SLOP = 15;
  var MARKER_TEX = 256;
  // Clamp the quad's vertices to the near/far planes so it is never plane
  // clipped. Copied from the viewer's own hotspot material; written on ONE line
  // because a multi-line string here would need escapes this file cannot carry.
  var MARKER_CLAMP_GLSL = 'float f = gl_Position.z / gl_Position.w; if (f > 1.0) { gl_Position.z = gl_Position.w; } else if (f < -1.0) { gl_Position.z = -gl_Position.w; }';
  var MARKER_CLAMP_WGSL = 'let f = output.position.z / output.position.w; if (f > 1.0) { output.position.z = output.position.w; } else if (f < -1.0) { output.position.z = -output.position.w; }';

  var markerLayer = null;      // our render Layer, inserted before the splats
  var markerMesh = null;       // one shared unit plane
  var markerTexture = null;    // one shared canvas-drawn disc + door glyph
  var markerBaseColor = null;  // idle emissive
  var markerHoverColor = null; // hover emissive
  var markerCamera = null;     // the viewer's camera Entity
  var markerCanvas = null;     // the viewer's canvas element, hit-tested directly
  var markerRoot = null;       // our DOM container (tooltip only, never the viewer's #annotations)
  var markerTip = null;        // our tooltip div
  var markerTipOwner = -1;     // portal index owning the open tooltip, -1 = none
  var markerHovered = -1;
  var markerCursorSaved = '';  // canvas cursor as it was when the hover started
  var markerNoui = false;
  var markerScene = -1;        // active scene the markers were last refreshed for
  var markerDown = false;      // a canvas pointerdown is in flight
  var markerDownX = 0;
  var markerDownY = 0;
  var markers = [];            // portal index -> {entity, material, visible, axisU, axisV, sx, sy, ux, uy, vx, vy, onScreen}
  var markerViewPos = null;    // per-frame scratch (no allocation)
  var markerScreenPos = null;
  var markerAxisPos = null;    // world point on an in-plane half-axis
  var markerAxisScreen = null; // its projection

  // Rounded rect via arcTo: ctx.roundRect is too new to rely on.
  function markerRoundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Black disc + white ring + the app's door glyph, drawn to a canvas and
  // uploaded once. The glyph is traced from src/ui/svg/portal.svg in its own
  // 38-unit box: rect x=12 y=7 w=14 h=24 rx=1.5 stroked at width 2, plus a
  // filled r=1.2 knob dot at (23, 19).
  function markerMakeTexture(pcns, device) {
    var canvas = document.createElement('canvas');
    canvas.width = MARKER_TEX;
    canvas.height = MARKER_TEX;
    var ctx = canvas.getContext('2d');
    if (!ctx) { return null; }
    var S = MARKER_TEX;
    var c = S / 2;
    // Clear to WHITE at zero alpha: the fixup loop below relies on it.
    ctx.fillStyle = 'white';
    ctx.globalAlpha = 0;
    ctx.fillRect(0, 0, S, S);
    ctx.globalAlpha = 1;
    var ring = S * 0.055;
    var radius = c - ring;
    ctx.beginPath();
    ctx.arc(c, c, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'black';
    ctx.fill();
    ctx.lineWidth = ring;
    ctx.strokeStyle = 'white';
    ctx.stroke();
    var u = (S / 38) * 0.74;             // glyph units -> px, shrunk to sit inside the disc
    var ox = c - 19 * u;
    var oy = c - 19 * u;
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2 * u;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    markerRoundRect(ctx, ox + 12 * u, oy + 7 * u, 14 * u, 24 * u, 1.5 * u);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ox + 23 * u, oy + 19 * u, 1.2 * u, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
    // Force the colour channels of semi-transparent pixels to white so the
    // ring's antialiased edge blends correctly (the viewer does the same).
    var img = ctx.getImageData(0, 0, S, S);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 255) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
    }
    return new pcns.Texture(device, {
      width: S,
      height: S,
      format: pcns.PIXELFORMAT_RGBA8,
      magFilter: pcns.FILTER_LINEAR,
      minFilter: pcns.FILTER_LINEAR,
      mipmaps: false,
      levels: [new Uint8Array(d.buffer)]
    });
  }

  // One material per marker: hover re-tints the emissive, and a shared material
  // would tint every icon at once.
  function markerMakeMaterial(pcns, tex, color) {
    var m = new pcns.StandardMaterial();
    m.diffuse = new pcns.Color(0, 0, 0);
    m.emissive.copy(color);
    m.emissiveMap = tex;
    m.opacityMap = tex;
    m.opacity = 1;
    m.alphaTest = 0.01;
    m.blendState = new pcns.BlendState(
      true,
      pcns.BLENDEQUATION_ADD, pcns.BLENDMODE_SRC_ALPHA, pcns.BLENDMODE_ONE_MINUS_SRC_ALPHA,
      pcns.BLENDEQUATION_ADD, pcns.BLENDMODE_ONE, pcns.BLENDMODE_ONE
    );
    m.depthTest = true;
    m.depthWrite = true;
    m.cull = pcns.CULLFACE_NONE;
    m.useLighting = false;
    try {
      m.shaderChunks.glsl.add({ litUserMainEndVS: MARKER_CLAMP_GLSL });
      m.shaderChunks.wgsl.add({ litUserMainEndVS: MARKER_CLAMP_WGSL });
    } catch (chunkErr) {}
    m.update();
    return m;
  }

  // The viewer registers RenderComponentSystem in its appOptions (verified in
  // the 3.1.7 bundle), so addComponent('render') is available even in an export
  // that has no annotations.
  function markerMakeOne(pcns, app, portal, index) {
    var material = markerMakeMaterial(pcns, markerTexture, markerBaseColor);
    var mi = new pcns.MeshInstance(markerMesh, material);
    mi.cull = false;
    var entity = new pcns.Entity('portal-marker-' + index);
    entity.addComponent('render', { layers: [markerLayer.id], meshInstances: [mi] });
    app.root.addChild(entity);
    entity.setPosition(portal.position[0], portal.position[1], portal.position[2]);
    // Lie flat IN the portal plane rather than turning to face the camera.
    // PlaneGeometry spans local XZ with a +Y normal, and +90 about X sends +Y
    // to +Z -- the portal normal axis, matching portal-export's
    // rotateByQuat(rotation, [0, 0, 1]). The rotation never changes, so this is
    // set once and markerUpdate does no orientation work at all.
    var r = portal.rotation || [0, 0, 0, 1];
    entity.setRotation(new pcns.Quat(r[0], r[1], r[2], r[3]));
    entity.rotateLocal(90, 0, 0);
    // The quad spans the entity's local X and Z, so these two world vectors are
    // its in-plane axes: right is the world image of local +X, forward is the
    // world image of local -Z (not +Z -- irrelevant here since the ellipse
    // this feeds is symmetric about its centre). Constant for the same reason
    // as the rotation, so capture them here and keep the per-frame path
    // allocation-free.
    var axisU = entity.right.clone();
    var axisV = entity.forward.clone();
    entity.enabled = false;
    return {
      entity: entity, material: material, visible: false,
      axisU: axisU, axisV: axisV,
      sx: 0, sy: 0, ux: 0, uy: 0, vx: 0, vy: 0, onScreen: false
    };
  }

  // Whether the icons should respond to the pointer at all right now. Read
  // fresh on every use rather than cached on an event: the viewer's own guards
  // call in at click time and must never see a stale answer.
  function markerCanInteract() {
    var st = getState();
    return markerInteractive({
      cameraMode: (st && st.cameraMode) || 'orbit',
      gamingControls: !!(st && st.gamingControls)
    });
  }

  // Also drives the canvas cursor: a marker can only be hovered via the
  // canvas pointer handlers below, so this is the single place a hover
  // starts or ends, and the single place the cursor is restored.
  function markerSetHover(index, on) {
    var m = markers[index];
    if (!m || !m.material) { return; }
    if (on) {
      markerHovered = index;
      if (markerCanvas) {
        // Save and restore rather than clear: the viewer sets its own 'pointer'
        // whenever a click can target something, and clearing to '' left a
        // default arrow behind until the user's next click. If the viewer
        // changes the cursor WHILE an icon is hovered we write back a stale
        // value -- accepted, it self-heals on the next pointerdown/up pair.
        markerCursorSaved = markerCanvas.style.cursor;
        markerCanvas.style.cursor = 'pointer';
      }
    } else if (markerHovered === index) {
      markerHovered = -1;
      if (markerCanvas) { markerCanvas.style.cursor = markerCursorSaved; }
    }
    m.material.emissive.copy(on ? markerHoverColor : markerBaseColor);
    m.material.update();
    if (liveApp) { liveApp.renderNextFrame = true; }
  }

  function markerOpenTip(index) {
    markerTipOwner = index;
    markerTip.classList.add('on');
    if (liveApp) { liveApp.renderNextFrame = true; }
    markerUpdate();          // position immediately, even if the camera is still
  }

  function markerCloseTip() {
    if (markerTipOwner === -1) { return; }
    markerTipOwner = -1;
    markerTip.classList.remove('on');
  }

  // Right of the icon by default, flipped left when it would overflow, clamped
  // to the viewport, arrow pointing back at the icon. Mirrors the viewer's own
  // annotation tooltip placement.
  function markerPositionTip(x, y) {
    var margin = 8;
    var offset = MARKER_SIZE * 0.6;
    var tw = markerTip.offsetWidth;
    var th = markerTip.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = x + offset;
    var flipped = false;
    if (left + tw > vw - margin) { left = x - offset - tw; flipped = true; }
    left = Math.max(margin, Math.min(left, vw - tw - margin));
    var top = Math.max(margin, Math.min(y - th / 2, vh - th - margin));
    markerTip.style.setProperty('--ss-tip-arrow', Math.max(12, Math.min(y - top, th - 12)) + 'px');
    markerTip.classList.toggle('arrow-right', !flipped);
    markerTip.classList.toggle('arrow-left', flipped);
    markerTip.style.left = left + 'px';
    markerTip.style.top = top + 'px';
  }

  // Per-frame: constant-screen-size scale, project the icon centre and the
  // two in-plane half-axes, and cache the results for the canvas pointer
  // handlers' elliptical hit test. Only enabled markers are touched, so the
  // cost tracks the portals in the ACTIVE scene rather than the whole bundle.
  function markerUpdate() {
    if (!markerLayer || !markerCamera || !liveApp) { return; }
    var cam = markerCamera.camera;
    var canvasHeight = liveApp.graphicsDevice.canvas.clientHeight;
    var viewMatrix = cam.viewMatrix;
    var proj5 = cam.projectionMatrix.data[5];
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      if (!m || !m.visible) { continue; }
      var p = m.entity.getPosition();
      viewMatrix.transformPoint(p, markerViewPos);
      if (markerViewPos.z >= 0) {
        m.onScreen = false;
        if (markerHovered === i) { markerSetHover(i, false); }
        if (markerTipOwner === i) { markerCloseTip(); }
        continue;
      }
      cam.worldToScreen(p, markerScreenPos);
      var s = markerScale(MARKER_SIZE, canvasHeight, proj5, -markerViewPos.z);
      m.entity.setLocalScale(s, s, s);
      m.sx = markerScreenPos.x;
      m.sy = markerScreenPos.y;
      // Project the quad's two in-plane half-axes. Their screen images are the
      // conjugate half-axes of the ellipse the disc projects to, which is
      // exactly the clickable region. PlaneGeometry is 1x1, so the half extent
      // at uniform scale s is s * 0.5 -- half the marker size in pixels when
      // the portal faces the camera.
      var half = s * 0.5;
      markerAxisPos.set(p.x + m.axisU.x * half, p.y + m.axisU.y * half, p.z + m.axisU.z * half);
      cam.worldToScreen(markerAxisPos, markerAxisScreen);
      m.ux = markerAxisScreen.x - m.sx;
      m.uy = markerAxisScreen.y - m.sy;
      markerAxisPos.set(p.x + m.axisV.x * half, p.y + m.axisV.y * half, p.z + m.axisV.z * half);
      cam.worldToScreen(markerAxisPos, markerAxisScreen);
      m.vx = markerAxisScreen.x - m.sx;
      m.vy = markerAxisScreen.y - m.sy;
      m.onScreen = true;
      if (markerTipOwner === i) {
        markerTip.classList.add('on');
        markerPositionTip(markerScreenPos.x, markerScreenPos.y);
      }
    }
  }

  // Re-evaluate which markers are enabled. Called on scene change, on camera
  // mode change and on every portal transition phase change.
  function refreshPortalMarkers() {
    if (!markerLayer) { return; }
    // A portal touches both scenes it connects, so it can still be wanted
    // after a crossing -- an open tooltip must not ride through to the new
    // scene regardless of which transition cover (or none) got us there.
    if (activeIndex !== markerScene) {
      markerCloseTip();
      markerScene = activeIndex;
    }
    if (!markerCanInteract()) {
      markerCloseTip();
      if (markerHovered !== -1) { markerSetHover(markerHovered, false); }
    }
    var st = getState();
    var visible = markerVisible({
      noui: markerNoui,
      cameraMode: (st && st.cameraMode) || 'orbit',
      transitionActive: !!(transState && transState.phase !== 'idle')
    });
    var wanted = visible ? portalsForScene(data.portals || [], activeIndex) : [];
    var on = {};
    for (var w = 0; w < wanted.length; w++) { on[wanted[w]] = true; }
    var changed = false;
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      if (!m) { continue; }
      var want = !!on[i];
      if (m.visible === want) { continue; }
      changed = true;
      m.visible = want;
      m.entity.enabled = want;
      if (!want) {
        m.onScreen = false;
        if (markerHovered === i) { markerSetHover(i, false); }
        if (markerTipOwner === i) { markerCloseTip(); }
      }
    }
    if (changed && liveApp) { liveApp.renderNextFrame = true; }
  }

  // Build once, after the portals companion has captured the live app. Every
  // failure path is soft: no icons, everything else untouched.
  function buildPortalMarkers() {
    var pcns = window.__ssPc;
    if (!pcns || !liveApp || markerLayer) { return; }
    try {
      var app = liveApp;
      var camComp = app.root.findComponent('camera');
      if (!camComp) { return; }
      var layers = app.scene.layers;
      var world = layers.getLayerByName('World');
      if (!world) { return; }
      markerTexture = markerMakeTexture(pcns, app.graphicsDevice);
      if (!markerTexture) { return; }
      markerCamera = camComp.entity;
      // Inserted right after World OPAQUE: the splats render later and paint
      // over an occluded icon. There is deliberately no always-on-top copy.
      markerLayer = new pcns.Layer({ name: 'PortalMarkers' });
      layers.insert(markerLayer, layers.getOpaqueIndex(world) + 1);
      markerCamera.camera.layers = markerCamera.camera.layers.concat([markerLayer.id]);
      markerBaseColor = new pcns.Color(0.85, 0.85, 0.85);
      markerHoverColor = new pcns.Color(1.0, 0.4, 0.0);
      var viewer = window.__supersplatViewer;
      if (viewer && viewer.cameraFrame) {
        // The viewer gamma-corrects its own hotspot colours when a camera frame
        // (post-processing) is active; match it or the icons read washed out.
        markerBaseColor.gamma();
        markerHoverColor.gamma();
      }
      markerMesh = pcns.Mesh.fromGeometry(app.graphicsDevice, new pcns.PlaneGeometry({ widthSegments: 1, lengthSegments: 1 }));
      markerViewPos = new pcns.Vec3();
      markerScreenPos = new pcns.Vec3();
      markerAxisPos = new pcns.Vec3();
      markerAxisScreen = new pcns.Vec3();
      markerRoot = document.createElement('div');
      markerRoot.className = 'ss-portal-markers';
      document.body.appendChild(markerRoot);
      markerTip = document.createElement('div');
      markerTip.className = 'ss-portal-marker-tip';
      markerTip.textContent = resolveMarkerTooltip(markerTooltips, navigator.language || 'en');
      markerRoot.appendChild(markerTip);
      markerNoui = !!(window.sse && window.sse.config && window.sse.config.noui);
      var list = data.portals || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].position) { markers[i] = markerMakeOne(pcns, app, list[i], i); }
      }
      app.on('prerender', markerUpdate);
      // Hit-testing lives on the canvas, not a DOM overlay: a per-marker div
      // sitting over the canvas would swallow the orbit-drag / click-to-walk
      // gesture that starts on a portal icon, and these icons sit exactly
      // where a user aims to walk through a doorway. All three listeners are
      // passive and never intercept the default action or halt the event's
      // travel, so the viewer's own camera controllers keep receiving every
      // event they would otherwise have received.
      markerCanvas = app.graphicsDevice.canvas;
      markerCanvas.addEventListener('pointerdown', function (downEv) {
        markerDown = true;
        markerDownX = downEv.clientX;
        markerDownY = downEv.clientY;
      }, { passive: true });
      markerCanvas.addEventListener('pointerup', function (upEv) {
        if (!markerDown) { return; }
        markerDown = false;
        if (!markerCanInteract()) { return; }
        var dx = upEv.clientX - markerDownX;
        var dy = upEv.clientY - markerDownY;
        if (Math.sqrt(dx * dx + dy * dy) >= MARKER_CLICK_SLOP) {
          // a drag, not a click -- close any open tooltip and do nothing else
          markerCloseTip();
          return;
        }
        var rect = markerCanvas.getBoundingClientRect();
        // Hit-test the PRESS position, not the release position: the engine-side
        // guard consults _lastPointerOffsetX/Y, which the bundle assigns only in
        // _onPointerDown, so the two must read one sample or a click near an
        // icon's edge can both navigate and open a tooltip.
        var hit = markerHitTest(markers, markerDownX - rect.left, markerDownY - rect.top);
        if (hit === -1 || hit === markerTipOwner) { markerCloseTip(); } else { markerOpenTip(hit); }
      }, { passive: true });
      markerCanvas.addEventListener('pointermove', function (moveEv) {
        if (!markerCanInteract()) {
          if (markerHovered !== -1) { markerSetHover(markerHovered, false); }
          return;
        }
        var rect = markerCanvas.getBoundingClientRect();
        var hit = markerHitTest(markers, moveEv.clientX - rect.left, moveEv.clientY - rect.top);
        if (hit !== markerHovered) {
          if (markerHovered !== -1) { markerSetHover(markerHovered, false); }
          if (hit !== -1) { markerSetHover(hit, true); }
        }
      }, { passive: true });
      // No further pointermove fires once the pointer leaves the canvas (or
      // the browser cancels the pointer, e.g. palm rejection or a gesture
      // takeover), so a hover left active there would stick the tint and
      // cursor. The old DOM-div implementation got this for free from
      // pointerenter/pointerleave firing on the div itself.
      var markerClearHover = function () {
        if (markerHovered !== -1) { markerSetHover(markerHovered, false); }
      };
      markerCanvas.addEventListener('pointerleave', markerClearHover, { passive: true });
      markerCanvas.addEventListener('pointercancel', markerClearHover, { passive: true });
      // Published for the two viewer-engine patches that guard the viewer's own
      // click-to-navigate decision points: a click landing on an icon shows the
      // tooltip and must not also move the camera. Coordinates are
      // canvas-relative CSS pixels -- the same space as the viewer's
      // _lastPointerOffsetX/Y. Markers suppressed by noui, anim playback or a
      // running transition are already not onScreen, so this is inert then.
      window.__ssPortalMarkerAt = function (x, y) {
        return markerCanInteract() && markerHitTest(markers, x, y) !== -1;
      };
      refreshPortalMarkers();
    } catch (markerErr) {
      console.warn('portal markers disabled:', markerErr);
    }
  }
`;

export { markerRuntime, markerStyle };
