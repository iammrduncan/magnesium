// Renders a mock canvas board (`*.dc.html`) in any browser, with nothing
// behind it. Each board loads `./support.js`; this is Magnesium's own runtime
// for the subset of the Design Component format the boards use:
//   - `{{path}}` holes in text and attributes: a dotted lookup into what the
//     board's `renderVals()` returns, or a literal (`{{ true }}`);
//   - `<sc-for list as>`, `<sc-if value>`, and `<dc-import name>` for a sibling
//     board used as a child (its other attributes become props);
//   - `<helmet>`, whose styles and font links go into the page's head;
//   - `on*` attributes bound to functions (`onChange` fires on every input,
//     as in React);
//   - `class Component extends DCLogic`, with props, state and setState.
// Query parameters are the top board's props: `Session.dc.html?theme=dark`.
// Served over http (`vp run mocks`) it reads the board's raw source, so a
// `<sc-for>` inside a table stays where it was written.
(() => {
  "use strict";

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const HOLE = /\{\{\s*([^}]*?)\s*\}\}/g;
  const WHOLE = /^\s*\{\{\s*([^}]*?)\s*\}\}\s*$/;

  const hide = document.createElement("style");
  hide.textContent = "x-dc{display:none}dc-host{display:contents}";
  document.head.appendChild(hide);

  class DCLogic {
    constructor(props) {
      this.props = props || {};
      this.state = null;
    }
    setState(patch) {
      const next = typeof patch === "function" ? patch(this.state || {}, this.props) : patch;
      this.state = Object.assign({}, this.state || {}, next);
      this.__schedule?.();
    }
    forceUpdate() {
      this.__schedule?.();
    }
  }
  window.DCLogic = DCLogic;

  // Browsers move unknown elements out of tables; templates may stay anywhere.
  const prepare = (html) =>
    html.replace(/<(\/?)sc-(for|if)\b/g, (_, close, kind) =>
      close ? "</template" : `<template data-sc="${kind}"`,
    );

  const lookup = (expr, scope) => {
    if (expr === "true") return true;
    if (expr === "false") return false;
    if (expr === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    if (/^(['"]).*\1$/.test(expr)) return expr.slice(1, -1);
    let value = scope;
    for (const part of expr.split(".")) {
      if (value == null) return undefined;
      value = value[part];
    }
    return value;
  };

  const interpolate = (text, scope) =>
    text.replace(HOLE, (_, expr) => {
      const value = lookup(expr, scope);
      return value == null ? "" : String(value);
    });

  const resolve = (value, scope) => {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(whole[1], scope);
    return value.includes("{{") ? interpolate(value, scope) : value;
  };

  const eventType = (attribute, tag) => {
    const type = attribute.slice(2);
    return type === "change" && (tag === "input" || tag === "textarea") ? "input" : type;
  };

  const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  /** The board's template, rendered with `scope`, as plain descriptions of nodes. */
  const render = (nodes, scope, out) => {
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        out.push({ text: text.includes("{{") ? interpolate(text, scope) : text });
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.localName;
      if (tag === "helmet") continue;
      const kind = tag === "template" ? node.getAttribute("data-sc") : null;
      if (kind === "if") {
        if (resolve(node.getAttribute("value") || "", scope))
          render(node.content.childNodes, scope, out);
        continue;
      }
      if (kind === "for") {
        const list = resolve(node.getAttribute("list") || "", scope) || [];
        const as = node.getAttribute("as") || "item";
        Array.from(list).forEach((item, index) => {
          const inner = Object.create(scope);
          inner[as] = item;
          inner.$index = index;
          render(node.content.childNodes, inner, out);
        });
        continue;
      }
      if (tag === "dc-import") {
        const props = {};
        for (const { name, value } of node.attributes) {
          if (name !== "name" && !name.startsWith("hint-"))
            props[camel(name)] = resolve(value, scope);
        }
        out.push({ component: node.getAttribute("name"), props });
        continue;
      }
      const element = {
        tag,
        ns: node.namespaceURI,
        attrs: {},
        props: {},
        events: {},
        children: [],
      };
      for (const { name, value } of node.attributes) {
        if (name.startsWith("hint-")) continue;
        const resolved = resolve(value, scope);
        if (name.startsWith("on") && typeof resolved === "function") {
          element.events[eventType(name, tag)] = resolved;
        } else if (name === "value" || name === "checked") {
          element.props[name] = resolved;
        } else if (resolved == null || (resolved === false && !name.startsWith("aria-"))) {
          continue;
        } else {
          element.attrs[name] = String(resolved);
        }
      }
      render(node.childNodes, scope, element.children);
      out.push(element);
    }
  };

  const sameKind = (dom, next) => {
    if ("text" in next) return dom.nodeType === Node.TEXT_NODE;
    if (next.component) return dom.localName === "dc-host" && dom.__name === next.component;
    return (
      dom.nodeType === Node.ELEMENT_NODE &&
      dom.localName === next.tag &&
      dom.namespaceURI === next.ns
    );
  };

  const unmountAll = (dom) => {
    if (dom.nodeType !== Node.ELEMENT_NODE) return;
    for (const host of [dom, ...dom.querySelectorAll("dc-host")]) {
      host.__instance?.componentWillUnmount?.();
    }
  };

  const create = (next) => {
    if ("text" in next) return document.createTextNode(next.text);
    if (next.component) {
      const host = document.createElement("dc-host");
      host.__name = next.component;
      host.__props = next.props;
      loadBoard(next.component).then((board) => {
        host.__instance = mount(host, board, host.__props);
      });
      return host;
    }
    const dom =
      next.ns && next.ns !== HTML_NS
        ? document.createElementNS(next.ns, next.tag)
        : document.createElement(next.tag);
    update(dom, next);
    return dom;
  };

  /** Brings `dom` in line with `next`, keeping the node, so focus and scroll stay. */
  const update = (dom, next) => {
    if ("text" in next) {
      if (dom.nodeValue !== next.text) dom.nodeValue = next.text;
      return;
    }
    if (next.component) {
      dom.__props = next.props;
      const instance = dom.__instance;
      if (instance) {
        instance.props = next.props;
        instance.__schedule();
      }
      return;
    }
    const previous = dom.__attrs || {};
    for (const name in previous) if (!(name in next.attrs)) dom.removeAttribute(name);
    for (const name in next.attrs) {
      if (previous[name] !== next.attrs[name]) dom.setAttribute(name, next.attrs[name]);
    }
    dom.__attrs = next.attrs;
    for (const name in next.props) {
      const value = name === "checked" ? Boolean(next.props[name]) : (next.props[name] ?? "");
      if (dom[name] !== value) dom[name] = value;
    }
    dom.__events = next.events;
    for (const type in next.events) {
      dom.__bound = dom.__bound || new Set();
      if (dom.__bound.has(type)) continue;
      dom.__bound.add(type);
      dom.addEventListener(type, (event) => dom.__events[type]?.(event));
    }
    patch(dom, next.children);
  };

  const patch = (parent, children) => {
    let index = 0;
    for (; index < children.length; index++) {
      const next = children[index];
      const dom = parent.childNodes[index];
      if (dom && sameKind(dom, next)) {
        update(dom, next);
      } else if (dom) {
        unmountAll(dom);
        parent.replaceChild(create(next), dom);
      } else {
        parent.appendChild(create(next));
      }
    }
    while (parent.childNodes.length > index) {
      unmountAll(parent.lastChild);
      parent.removeChild(parent.lastChild);
    }
  };

  /** A parsed board: its template, and its Component class. Helmet goes to the head once. */
  const compile = (doc) => {
    const root = doc.querySelector("x-dc");
    for (const helmet of root.querySelectorAll("helmet")) {
      for (const child of helmet.children)
        document.head.appendChild(document.importNode(child, true));
    }
    const script = doc.querySelector('script[type="text/x-dc"]');
    const Component = new Function(
      "DCLogic",
      `${script ? script.textContent : "class Component extends DCLogic {}"}\nreturn Component;`,
    )(DCLogic);
    return { root, Component };
  };

  const parse = (html) => compile(new DOMParser().parseFromString(prepare(html), "text/html"));

  const boards = new Map();
  const loadBoard = (name) => {
    if (!boards.has(name)) {
      const url = new URL(`${name}.dc.html`, location.href);
      boards.set(
        name,
        fetch(url)
          .then((response) => response.text())
          .then(parse),
      );
    }
    return boards.get(name);
  };

  const mount = (host, board, props) => {
    const instance = new board.Component(props || {});
    let queued = false;
    const draw = () => {
      queued = false;
      const values = instance.renderVals ? instance.renderVals() : {};
      const children = [];
      render(board.root.childNodes, values, children);
      patch(host, children);
    };
    instance.__schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(draw);
    };
    draw();
    instance.componentDidMount?.();
    return instance;
  };

  // A link to another board keeps this one's props, such as the theme.
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link || event.defaultPrevented || !link.getAttribute("href").endsWith(".dc.html")) return;
    event.preventDefault();
    location.href = new URL(link.getAttribute("href"), location.href).pathname + location.search;
  });

  const boot = async () => {
    const live = document.querySelector("x-dc");
    if (!live) return;
    const props = Object.fromEntries(new URLSearchParams(location.search));
    let board;
    try {
      // The raw source, so a <sc-for> in a table isn't moved by the parser.
      const response = await fetch(location.href);
      board = parse(await response.text());
    } catch {
      board = compile(document);
    }
    const host = document.createElement("div");
    host.id = "dc-root";
    live.replaceWith(host);
    mount(host, board, props);
    document.documentElement.dataset.dcReady = "true";
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
