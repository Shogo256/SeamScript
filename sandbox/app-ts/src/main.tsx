import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Feed } from "./feed";
import { App } from "./ui/App";
import "./styles.css";

declare global {
  interface Window {
    __feed?: Feed;
  }
}

performance.mark("seam:main");
const feed = new Feed({ render: new URLSearchParams(location.search).get("render") === "each" ? "each" : "frame" });
window.__feed = feed;
feed.start();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App feed={feed} />
  </StrictMode>,
);
