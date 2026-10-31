/**
 * Définition des vues de l'application.
 * Ordre imposé en V1.0 : Champions, Objets, Runes, Profil, Méta, Esport, Glossaire, Données.
 * Les identifiants servent aux liens ARIA entre onglets et panneaux.
 */

export type ViewId =
  | "champions"
  | "items"
  | "runes"
  | "profile"
  | "meta"
  | "esports"
  | "glossary"
  | "data";

export interface ViewDefinition {
  readonly id: ViewId;
  readonly label: string;
}

export const VIEWS: readonly ViewDefinition[] = [
  { id: "champions", label: "Champions" },
  { id: "items", label: "Objets" },
  { id: "runes", label: "Runes" },
  { id: "profile", label: "Profil" },
  { id: "meta", label: "Méta" },
  { id: "esports", label: "Esport" },
  { id: "glossary", label: "Glossaire" },
  { id: "data", label: "Données" },
];

export function panelId(view: ViewId): string {
  return `view-${view}`;
}

export function tabId(view: ViewId): string {
  return `tab-${view}`;
}
