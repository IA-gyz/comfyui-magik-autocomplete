// Run with: node --test tests/merged-integration.mjs
// ComfyUI lifecycle/DOM substitutes exercise the actual merged source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness() {
  const calls = [], extensions = [], observers = [], timers = new Map();
  let timerId = 0;
  class Textarea extends EventTarget {
    tagName = 'TEXTAREA'; offsetParent = {}; parentElement = null;
    querySelectorAll() { return []; }
  }
  const handler = name => class {
    handleInput() { calls.push(name + ':input'); }
    handleBlur() { calls.push(name + ':blur'); }
    applyFormatTextarea() { calls.push(name + ':manual'); }
  };
  const app = {graph: {_nodes: []}, registerExtension: e => extensions.push(e)};
  const context = vm.createContext({
    app, window: {}, console, HTMLTextAreaElement: Textarea,
    NodeInfo: class {constructor(nodeType, inputName) {Object.assign(this,{nodeType,inputName});}},
    AutocompleteEventHandler: handler('autocomplete'),
    RelatedTagsEventHandler: handler('related'), AutoFormatterEventHandler: handler('formatter'),
    ComfyWidgets: {STRING: node => ({widget: node.widgets[0]})},
    TagSource: {Danbooru:'danbooru'}, settingValues: {},
    setTimeout: fn => {timers.set(++timerId,fn); return timerId;},
    clearTimeout: id => timers.delete(id), requestAnimationFrame: () => {},
    MutationObserver: class {
      constructor(callback) {this.callback = callback; observers.push(this);}
      observe() {} disconnect() {this.disconnected = true;}
    },
  });
  for (const file of ['main.js','widget-bridge.js']) {
    const source = readFileSync(new URL('../web/js/'+file,import.meta.url),'utf8')
      .replace(/^import .*;\r?\n/gm,'').replace('export function attachTextarea','function attachTextarea')
      .replaceAll('import.meta.url','"https://example.invalid/extensions/Magik_Autocomplete/js/main.js"');
    vm.runInContext(source,context,{filename:file});
  }
  const bridge = extensions[1];
  bridge.init();
  const field = new Textarea();
  const node = {comfyClass:'MagikText',widgets:[{name:'text',element:field}]};
  app.graph._nodes.push(node);
  return {context,app,calls,extensions,bridge,field,node,observers};
}

test('native/custom discovery attaches only one listener set', () => {
  const h=harness();
  h.context.attachTextarea(h.field,new h.context.NodeInfo('MagikText','text'));
  h.bridge.nodeCreated(h.node); h.bridge.loadedGraphNode(h.node);
  h.field.dispatchEvent(new Event('input'));
  assert.deepEqual(h.calls,['autocomplete:input','related:input','formatter:input']);
  assert.equal(h.observers.length,1);
});
test('custom fields never auto-format', () => {
  const h=harness(); h.bridge.nodeCreated(h.node);
  h.field.dispatchEvent(new Event('input')); h.field.dispatchEvent(new Event('blur'));
  assert.deepEqual(h.calls,['autocomplete:input','related:input','autocomplete:blur','related:blur']);
});
test('bridge disable and re-enable works for existing nodes', () => {
  const h=harness(); h.bridge.nodeCreated(h.node);
  const enabled=h.bridge.settings.find(s=>s.id.endsWith('.Enabled'));
  enabled.onChange(false); h.field.dispatchEvent(new Event('input')); assert.equal(h.calls.length,0);
  enabled.onChange(true); h.field.dispatchEvent(new Event('input')); assert.equal(h.calls.length,2);
});
test('legacy and new APIs are identical; registration catches existing nodes', () => {
  const h=harness(); h.node.comfyClass='OtherText';
  h.bridge.nodeCreated(h.node); assert.equal(h.observers.length,0);
  const api=h.context.window.MagikAutocomplete;
  assert.equal(api,h.context.window.AutocompletePlusWidgetBridge);
  api.registerPrefix('Other'); h.field.dispatchEvent(new Event('input')); assert.equal(h.calls.length,2);
  api.unregisterPrefix('Other'); h.field.dispatchEvent(new Event('input')); assert.equal(h.calls.length,2);
});
test('readonly fields are excluded and observers are disconnected on removal', () => {
  const h=harness(); h.field.readOnly=true; h.bridge.nodeCreated(h.node);
  h.field.dispatchEvent(new Event('input')); assert.equal(h.calls.length,0);
  h.app.graph.onNodeRemoved(h.node); assert.ok(h.observers.every(o=>o.disconnected));
});
test('late replacement textarea is detected', () => {
  const h=harness(); const container=new h.field.constructor();
  container.tagName='DIV';
  // Use a non-textarea container for the custom widget.
  const widgetContainer=new EventTarget(); let children=[];
  widgetContainer.querySelectorAll=()=>children;
  h.node.widgets[0].element=widgetContainer;
  h.bridge.nodeCreated(h.node); children=[h.field]; h.observers[0].callback();
  h.field.dispatchEvent(new Event('input')); assert.equal(h.calls.length,2);
  const replacement=new h.field.constructor(); children=[replacement]; h.observers[0].callback();
  replacement.dispatchEvent(new Event('input')); assert.equal(h.calls.length,4);
});
test('legacy widget inputEl works', () => {
  const h=harness(); h.node.widgets=[{name:'text',inputEl:h.field}];
  h.bridge.nodeCreated(h.node); h.field.dispatchEvent(new Event('input')); assert.equal(h.calls.length,2);
});
