import { render } from "solid-js/web";
import App from "./App";
import "./index.css";

if (!crossOriginIsolated) {
  document.getElementById("root")!.innerHTML =
    '<div style="padding:2rem;font-family:sans-serif">' +
    "<h2>Cross-Origin Isolation Required</h2>" +
    "<p>This app requires <code>Cross-Origin-Opener-Policy: same-origin</code> " +
    "and <code>Cross-Origin-Embedder-Policy: require-corp</code> headers. " +
    "Please check your server configuration.</p></div>";
} else {
  render(() => <App />, document.getElementById("root")!);
}
