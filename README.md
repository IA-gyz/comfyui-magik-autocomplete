# Magik Autocomplete 1.0.0

Merged ComfyUI-Autocomplete-Plus and Magik Autocomplete Hooker into one standalone frontend extension. No workflow node is required.

## Install

1. Remove or disable **comfyui-autocomplete-plus** and **Magik_Autocomplete_Hooker**. Do not run the originals alongside this replacement: they attach their own listeners and popups.
2. Extract `Magik_Autocomplete` into `ComfyUI/custom_nodes/`.
3. If needed, install dependencies with your ComfyUI Python: `python -m pip install -r custom_nodes/Magik_Autocomplete/requirements.txt`.
4. Restart ComfyUI and refresh the browser (Ctrl+Shift+R).
5. Open Settings → **Magik Autocomplete**.

## Included

- Tag completion, aliases, source prioritization, fast search, LoRA and embedding suggestions.
- Related tags with source/category display and configurable activation/layout.
- Native prompt auto-formatting and Alt+Shift+F manual formatting.
- Support for custom DOM textareas, including asynchronously mounted/replaced widgets.
- Bundled Danbooru tag and related-tag CSVs from the supplied archive. Existing custom CSVs can be copied into this package's `data/` folder, keeping their original filenames.
- Existing autocomplete and bridge preference IDs retained for compatibility. Backend endpoints are namespaced to `/magik-autocomplete/`.

## Custom widgets

Magik node classes are supported by default on a fresh installation. In **Custom Widgets → Additional node-class prefixes**, enter comma-separated class prefixes for other packs. Existing saved bridge prefix settings take precedence. Read-only/disabled fields are ignored.

Automatic formatting is deliberately disabled on bridged fields to protect JSON/template text. The manual formatting shortcut is still available when explicitly invoked.

Other node packs can register from their extension's `setup`, `init` or `nodeCreated` hook:

```js
window.MagikAutocomplete?.registerPrefix("MyPack");
window.MagikAutocomplete?.registerMatcher(node => node.comfyClass === "MyNode");
```

The legacy `window.AutocompletePlusWidgetBridge` API remains an alias. Both expose `unregisterPrefix`, `unregisterMatcher`, `isActive`, `bridgedNodeInfo`, and `setDebug`. Unregistering stops bridged event processing for classes no longer matched. Turning custom-widget support back on rescans existing graph nodes.

Native and bridged fields share handlers and attachment tracking, so the same textarea receives only one set of listeners. The bridge does not depend on a particular install-folder name or a separately installed autocomplete package.

## Credits

Based on ComfyUI-Autocomplete-Plus by newtextdoc1111 (MIT; original LICENSE retained) and the supplied Magik Autocomplete Hooker. Original feature documentation is in `docs/Autocomplete_Plus_Upstream.md`.
