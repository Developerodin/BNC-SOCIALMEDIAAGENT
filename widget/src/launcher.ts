// Entry for askcart-launcher.js (Task 26), loaded on every storefront page by the app embed's schema `javascript`.
// Shopify adds it with `defer`, so #askcart-root is already parsed when this runs.
import { start } from "./launcher/launcher";

start();
