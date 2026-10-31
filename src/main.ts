/**
 * Point d'entrée de la WebView Tauri.
 * Aucune commande Tauri n'est appelée ici : tout passe par `src/api.ts`.
 */

import "./styles/theme.css";
import { mountApp } from "./app";

const root = document.querySelector<HTMLDivElement>("#app");

if (root === null) {
  throw new Error("LoL BOT : conteneur #app introuvable dans index.html.");
}

mountApp(root);
