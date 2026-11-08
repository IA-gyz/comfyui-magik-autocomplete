// Custom DOM widget discovery merged from Magik Autocomplete Hooker.
// Registration is opt-in by prefix or matcher. Magik classes are enabled by default.
// Uses the native autocomplete singleton and never auto-formats custom fields.
import { app } from "/scripts/app.js";

// --- Config ------------------------------------------------------------

import { attachTextarea } from "./main.js";
import { NodeInfo } from "./node-info.js";

const SETTING_PREFIX = "AutocompletePlusWidgetBridge";

let DEBUG = false;
let bridgeEnabled = true;

// --- Registration API ----------------------------------------------------
//
// Node packs opt themselves in from their OWN extension code:
//
//   window.AutocompletePlusWidgetBridge?.registerPrefix("MyPack");
//
// or, for anything more specific than a prefix match:
//
//   window.AutocompletePlusWidgetBridge?.registerMatcher(
//     (node) => node.comfyClass === "MyExactNode"
//   );
//
// IMPORTANT: call this from inside a lifecycle hook (setup(), nodeCreated(),
// init() - anything registered via app.registerExtension()), not from bare
// top-level module code. ComfyUI finishes importing every extension's JS
// file before it invokes any hook on any of them, so by the time any hook
// runs, window.AutocompletePlusWidgetBridge is guaranteed to exist. That is
// NOT guaranteed at plain top-level import time, where load order between
// custom_nodes folders is unspecified.
//
// End users can achieve the same thing with zero code, via the
// "Additional node-class prefixes" setting below.

const registeredPrefixes = new Set();
const registeredMatchers = new Set();
let settingsPrefixes = ["Magik"];

function registerPrefix(prefix) {
  if (typeof prefix === "string" && prefix.length) {
    registeredPrefixes.add(prefix);
    rescanExistingNodes(); // catch nodes created before this registration
  }
}
function unregisterPrefix(prefix) {
  registeredPrefixes.delete(prefix);
}
function registerMatcher(fn) {
  if (typeof fn === "function") {
    registeredMatchers.add(fn);
    rescanExistingNodes(); // same registration-order race applies to matchers
  }
}
function unregisterMatcher(fn) {
  registeredMatchers.delete(fn);
}

// Re-checks every node currently on the graph against the current
// prefixes/matchers. Called whenever a new prefix or matcher is registered,
// so bridging no longer depends on registration happening before ComfyUI's
// own nodeCreated/loadedGraphNode hooks fired for a given node. Safe to call
// before app.graph exists; the optional chains yield an empty list.
function rescanExistingNodes() {
  const nodes = app.graph?._nodes || app.graph?.nodes || [];
  for (const node of nodes) {
    if (shouldBridgeNode(node)) scheduleScan(node);
  }
}

function parsePrefixSetting(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function shouldBridgeNode(node) {
  const cls = node?.comfyClass;
  if (!cls) return false;
  for (const p of registeredPrefixes) if (cls.startsWith(p)) return true;
  for (const p of settingsPrefixes) if (cls.startsWith(p)) return true;
  for (const fn of registeredMatchers) {
    try {
      if (fn(node)) return true;
    } catch (err) {
      console.warn("[AutocompletePlusWidgetBridge] a registered matcher threw", err);
    }
  }
  return false;
}

// --- Element tracking -------------------------------------------------------

const bridgedElements = new WeakSet();
const bridgedNodeInfo = new WeakMap(); // element -> NodeInfo, exposed for debugging

// Best-effort semantic input name for NodeInfo. A common pattern among
// custom-DOM-widget nodes is "hide the native widget, keep mirroring the
// typed value into it", so a hidden widget's `name` is often the real input
// name (e.g. "text"). Falls back to the DOM widget's own name otherwise.
function guessInputName(node, domWidgetName) {
  const hiddenTextWidget = (node.widgets || []).find(
    (w) => w && w.hidden && typeof w.value === "string"
  );
  return hiddenTextWidget?.name || domWidgetName || "text";
}

function isVisibleEditableTextarea(el) {
  return (
    el instanceof HTMLTextAreaElement &&
    !el.readOnly &&
    !el.disabled &&
    el.offsetParent !== null // filters out display:none - e.g. a hidden native widget
  );
}

function bridgeTextarea(el, node, domWidgetName) {
  if (!bridgeEnabled) return;
  if (bridgedElements.has(el)) return;
  if (!isVisibleEditableTextarea(el)) return;

  bridgedElements.add(el);
  const nodeInfo = new NodeInfo(node.comfyClass, guessInputName(node, domWidgetName));
  bridgedNodeInfo.set(el, nodeInfo);

  attachTextarea(el, nodeInfo, {
    format: false,
    enabled: () => bridgeEnabled && shouldBridgeNode(node),
  });

  if (DEBUG) {
    console.log("[AutocompletePlusWidgetBridge] bridged", node.comfyClass, nodeInfo.inputName, el);
  }
}

// --- Mutation-based discovery -------------------------------------------
//
// Vue can render (or re-render) a DOM widget's contents after nodeCreated,
// on its own schedule - and some Vue-based widgets replace their DOM
// wholesale on later reactive re-renders too, rather than patching in
// place. Rather than guessing at either timing with fixed delays, every
// widget container gets a MutationObserver that reacts to actual DOM
// changes, for as long as the node stays on the graph. Bookkeeping keeps
// this safe under normal ComfyUI usage:
//  - at most one observer per widget container at a time - re-entrant
//    calls (nodeCreated + loadedGraphNode + a later registerPrefix rescan,
//    etc.) don't stack duplicate observers
//  - a ceiling timeout gives up and disconnects if a textarea NEVER shows
//    for a container, so a widget that will never produce one doesn't leak
//    an observer for the rest of the session
//  - once a container has produced a textarea at least once, the ceiling
//    is cancelled and the observer is left running indefinitely, so a
//    later element replacement (a re-render swapping in a new <textarea>)
//    gets caught and re-bridged automatically instead of silently
//    orphaning the bridge's listeners on a now-detached element
//  - all observers for a node are torn down when that node leaves the
//    graph, via a single graph-level onNodeRemoved hook (not a per-node
//    patch - see init() below)

const GIVE_UP_MS = 8000;

// node -> Map(observed element -> { observer, timeoutId })
// timeoutId is null once a container has produced a textarea at least once
// - see comment block above.
const pendingByNode = new WeakMap();

function clearPending(node, container) {
  const forNode = pendingByNode.get(node);
  const entry = forNode?.get(container);
  if (!entry) return;
  container.removeEventListener("focusin", entry.scan);
  entry.observer.disconnect();
  clearTimeout(entry.timeoutId);
  forNode.delete(container);
  if (forNode.size === 0) pendingByNode.delete(node);
}

// Disconnects every observer still tracked for a node, whether it's still
// waiting for a first match or watching indefinitely post-match. Called on
// node removal so deleting/recreating nodes during iterative work doesn't
// accumulate dangling observers.
function clearAllPending(node) {
  const forNode = pendingByNode.get(node);
  if (!forNode) return;
  for (const [target, { observer, timeoutId, scan }] of forNode) {
    target.removeEventListener("focusin", scan);
    observer.disconnect();
    clearTimeout(timeoutId);
  }
  pendingByNode.delete(node);
}

// Watches for a visible, editable <textarea> anywhere inside `container`,
// bridging every match found (bridgeTextarea no-ops on elements already in
// bridgedElements, so re-matching an already-bridged textarea on a later
// mutation is harmless - this is what lets the observer stay connected
// indefinitely without re-doing work). If `container` is itself a
// textarea, the element that actually receives a childList mutation when
// it's replaced is its PARENT, not the textarea itself - an element can't
// observe its own removal - so the watch target is container.parentElement
// in that case; the scan still finds container (or whatever replaces it)
// via querySelectorAll on that parent.
function watchForTextarea(container, node, domWidgetName) {
  const target = container instanceof HTMLTextAreaElement ? (container.parentElement || container) : container;
  if (!target || !target.querySelectorAll) return; // nothing observable here

  let forNode = pendingByNode.get(node);
  if (!forNode) {
    forNode = new Map();
    pendingByNode.set(node, forNode);
  }
  if (forNode.has(target)) return; // already watching this container

  const scan = () => {
    const matches = [...(target instanceof HTMLTextAreaElement ? [target] : []), ...target.querySelectorAll("textarea")].filter(
      isVisibleEditableTextarea
    );
    matches.forEach((ta) => bridgeTextarea(ta, node, domWidgetName));
    return matches.length > 0;
  };

  const observer = new MutationObserver(() => {
    if (!scan()) return;
    const entry = forNode.get(target);
    if (entry && entry.timeoutId) {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = null; // found at least once - keep watching indefinitely, no more giveup
    }
  });
  target.addEventListener("focusin", scan);
  observer.observe(target, { childList: true, subtree: true });

  const foundImmediately = scan(); // catches an already-present textarea, since the observer only fires on future mutations

  const timeoutId = foundImmediately
    ? null
    : setTimeout(() => {
        if (DEBUG) {
          console.log(
            "[AutocompletePlusWidgetBridge] gave up waiting for a textarea to mount",
            node.comfyClass, domWidgetName, target
          );
        }
        clearPending(node, target);
      }, GIVE_UP_MS);

  forNode.set(target, { observer, timeoutId, scan });
}

// --- Discovery: scan a node's DOM widgets for textareas ---------------------

function scanNode(node) {
  if (!bridgeEnabled || !shouldBridgeNode(node)) return;

  for (const w of node.widgets || []) {
    const el = w?.element ?? w?.inputEl;
    if (!el) continue;
    // watchForTextarea() does an immediate synchronous check before falling
    // back to observing, so one call covers "already present," "not
    // mounted yet," and "may get replaced later" uniformly.
    watchForTextarea(el, node, w.name);
  }
}

function isOnGraph(node) {
  const nodes = app.graph?._nodes || app.graph?.nodes || [];
  return nodes.includes(node);
}

// scanNode() only enumerates node.widgets as they exist at the moment it's
// called - it has no way to notice a widget that gets pushed into that
// array asynchronously afterward (e.g. a Vue-based DOM widget mounted via
// nextTick(), rather than added synchronously during node construction).
// That matters because nodeCreated is the ONLY hook that ever fires for an
// interactively-added node - unlike a node coming from a loaded workflow,
// there's no later loadedGraphNode pass to give it a second chance. Two
// cheap follow-up rescans close that gap: for widgets already seen,
// watchForTextarea() no-ops immediately (it bails out if that container is
// already being watched), so re-scanning costs nothing once nothing new
// has shown up. Guarded by isOnGraph() so a node deleted before either
// follow-up fires doesn't get a fresh, never-cleaned-up observer attached
// to it (onNodeRemoved already ran and won't run again for it).
function scheduleScan(node) {
  scanNode(node);
  const rescan = () => {
    if (isOnGraph(node)) scanNode(node);
  };
  requestAnimationFrame(rescan);
  setTimeout(rescan, 500);
}

// --- Extension registration --------------------------------------------------

app.registerExtension({
  name: SETTING_PREFIX,

  // Chains onto the graph's own onNodeRemoved callback once, rather than
  // patching anything on individual node classes/instances. ComfyExtension
  // has no per-extension nodeRemoved hook (confirmed against the current
  // frontend's extension interface), so this is the non-invasive
  // equivalent: one hook on the shared graph object, not per bridged node.
  init() {
    if (!app.graph) return;
    const prevOnNodeRemoved = app.graph.onNodeRemoved;
    app.graph.onNodeRemoved = function (node) {
      clearAllPending(node);
      return prevOnNodeRemoved?.apply(this, arguments);
    };
  },

  async setup() {

    // Catch up on matching nodes that already exist at startup.
    rescanExistingNodes();
  },

  nodeCreated(node) {
    if (shouldBridgeNode(node)) scheduleScan(node);
  },

  loadedGraphNode(node) {
    if (shouldBridgeNode(node)) scheduleScan(node);
  },

  settings: [
    {
      category: ["Magik Autocomplete", "Custom Widgets"],
      id: `${SETTING_PREFIX}.Enabled`,
      name: "Enable Custom Widget Support",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Extends Magik Autocomplete tag " +
        "autocomplete and related-tags features onto custom-DOM-widget text " +
        "nodes registered below or by other node packs.",
      onChange: (v) => {
        bridgeEnabled = !!v;
        if (bridgeEnabled) rescanExistingNodes();
      },
    },
    {
      category: ["Magik Autocomplete", "Custom Widgets"],
      id: `${SETTING_PREFIX}.ExtraPrefixes`,
      name: "Additional node-class prefixes",
      type: "text",
      defaultValue: "Magik",
      tooltip:
        "Comma-separated list of comfyClass prefixes to bridge, e.g. " +
        "'Pixaroma,MyOtherPack'. Any node whose class name starts with one " +
        "of these gets scanned for textareas. Node packs can also opt " +
        "themselves in from their own code - see README.md.",
      onChange: (v) => {
        settingsPrefixes = parsePrefixSetting(v);
        rescanExistingNodes(); // same race as registerPrefix/registerMatcher - close it here too
      },
    },
    {
      category: ["Magik Autocomplete", "Custom Widgets"],
      id: `${SETTING_PREFIX}.Debug`,
      name: "Debug logging",
      type: "boolean",
      defaultValue: false,
      tooltip: "Log every bridge decision to the browser console.",
      onChange: (v) => {
        DEBUG = !!v;
      },
    },
  ],
});

// --- Public window API -------------------------------------------------------

window.MagikAutocomplete = window.AutocompletePlusWidgetBridge = {
  registerPrefix,
  unregisterPrefix,
  registerMatcher,
  unregisterMatcher,
  isActive: () => bridgeEnabled,
  bridgedNodeInfo,
  setDebug: (v) => {
    DEBUG = !!v;
  },
};
