/**
 * Helpers de construction du DOM.
 *
 * Aucune chaîne HTML n'est jamais interprétée : le texte passe par
 * `textContent` (nœuds texte) et les attributs par `setAttribute`.
 * Les données venant du backend restent donc des données, jamais du balisage.
 */

export type Child = Node | string | null | undefined;

export interface ElementOptions {
  /** Classes CSS appliquées telles quelles. */
  readonly className?: string;
  /** Texte inséré comme nœud texte (jamais interprété comme HTML). */
  readonly text?: string;
  /** Attributs HTML à appliquer. */
  readonly attrs?: Readonly<Record<string, string>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: ElementOptions,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options?.className !== undefined) {
    node.className = options.className;
  }
  if (options?.text !== undefined) {
    node.textContent = options.text;
  }
  if (options?.attrs !== undefined) {
    for (const [name, value] of Object.entries(options.attrs)) {
      node.setAttribute(name, value);
    }
  }
  return node;
}

/** Ajoute des nœuds et des chaînes (converties en nœuds texte) en ignorant null. */
export function append(parent: Node, ...children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

/** Remplace tout le contenu d'un élément par des nœuds/textes sûrs. */
export function replaceContent(parent: Element, ...children: readonly Child[]): void {
  const nodes: (Node | string)[] = [];
  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    nodes.push(child);
  }
  parent.replaceChildren(...nodes);
}
