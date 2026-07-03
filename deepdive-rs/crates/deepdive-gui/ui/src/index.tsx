/* @refresh reload */
import { render } from "solid-js/web";

import App from "./App";
import "./app.css";
import "./kobalte.css";
import "./overrides.css";

render(() => <App />, document.getElementById("root")!);
