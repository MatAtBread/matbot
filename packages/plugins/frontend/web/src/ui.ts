import { promises } from "node:fs";
const { readFile } = promises;
export const html = () => readFile(new URL("./index.html", import.meta.url), "utf-8");
export const js = () =>  readFile(new URL("./app.js", import.meta.url), "utf-8");
