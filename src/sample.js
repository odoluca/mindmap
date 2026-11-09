// The example map shown on first launch.
import { newMap, applyOps } from './model.js';

export function sampleMap() {
  const map = newMap({ name: 'Welcome to Mindmap', root: 'Mindmap' });
  const root = map.nodes[0].id;
  applyOps(map, [
    { op: 'addTree', parent: root, nodes: [
      { text: 'Editing', color: 'blue', children: [
        { text: 'Tab adds a child, Enter a sibling' },
        { text: 'Double-click a node to edit its text' },
        { text: 'Drag a node onto another to move it there' },
        { text: 'Drag the small dot on a node to draw a link' },
        { text: 'Delete removes the selection' },
      ] },
      { text: 'Layouts', color: 'green', children: [
        { text: 'Balanced mind map (default)' },
        { text: 'Right, down or radial trees' },
        { text: 'Layered for flowcharts' },
        { text: 'Free: place nodes anywhere' },
      ] },
      { text: 'AI access', color: 'purple', children: [
        { text: 'Paste JSON, operations or an outline', notes: 'Copy the map with Export ▾, give it to any AI, paste the answer back.' },
        { text: 'Links with #ops= or #outline=' },
        { text: 'window.mindmap for browser agents', notes: 'Open the console and type mindmap.help()' },
        { text: 'Notes and a change log record who did what' },
      ] },
      { text: 'Saved in your browser', color: 'orange', children: [
        { text: 'No account, no server' },
        { text: 'Export JSON, SVG, PNG or Markdown' },
        { text: 'Open a JSON or Markdown file to import' },
      ] },
      { text: 'Flowcharts too', color: 'teal', children: [
        { text: 'Decision', shape: 'diamond' },
        { text: 'Process', shape: 'rect' },
        { text: 'Start / End', shape: 'stadium' },
        { text: 'Data', shape: 'parallelogram' },
      ] },
    ] },
  ], { author: 'user' });
  const by = (t) => map.nodes.find((n) => n.text === t).id;
  applyOps(map, [
    { op: 'addEdge', from: by('Paste JSON, operations or an outline'), to: by('Export JSON, SVG, PNG or Markdown'), label: 'round trip', directed: false },
    { op: 'addNote', target: by('AI access'), text: 'Try it: select this node, then paste an outline from your clipboard.' },
  ], { author: 'user' });
  map.log = [];
  return map;
}
