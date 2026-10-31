/**
 * Indicateur de connexion déduit UNIQUEMENT des données du cache :
 * aucune sonde réseau côté interface, le backend est la source de vérité.
 */

import type { DataStatus } from "../types";

export type ConnectionState = "pending" | "empty" | "online" | "offline" | "unavailable";

export interface ConnectionInfo {
  readonly state: ConnectionState;
  readonly label: string;
  readonly detail: string;
}

export function describeConnection(status: DataStatus | null): ConnectionInfo {
  if (status === null) {
    return {
      state: "pending",
      label: "Initialisation",
      detail: "Lecture du cache local Data Dragon…",
    };
  }
  if (status.version === null) {
    return {
      state: "empty",
      label: "Cache vide",
      detail: "Aucune donnée Data Dragon n'est encore présente dans le cache local.",
    };
  }
  if (status.offline) {
    return {
      state: "offline",
      label: "Hors ligne",
      detail: "Dernière synchronisation en échec : les données affichées viennent du cache local.",
    };
  }
  return {
    state: "online",
    label: "En ligne",
    detail: "Dernière synchronisation Data Dragon réussie.",
  };
}
