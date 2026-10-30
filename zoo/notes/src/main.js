// @ts-check
// The notes app: a list of notes, an editor that saves by itself as you type, Save and Delete.
import { invoke, listen } from "./tauri.js";

/** @typedef {{ id: number, body: string, rev: number, updatedAt: string }} Note */

/** Autosave waits for the typing to stop this long. */
const AUTOSAVE_MS = 400;

const newButton = /** @type {HTMLButtonElement} */ (element("#new"));
const list = /** @type {HTMLUListElement} */ (element("#notes"));
const empty = /** @type {HTMLParagraphElement} */ (element("#empty"));
const editor = /** @type {HTMLTextAreaElement} */ (element("#editor"));
const status = /** @type {HTMLParagraphElement} */ (element("#status"));
const saveButton = /** @type {HTMLButtonElement} */ (element("#save"));
const deleteButton = /** @type {HTMLButtonElement} */ (element("#delete"));

/** @type {Note[]} */
let notes = [];
/** @type {Note | undefined} */
let current;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let autosave;
/**
 * The save in flight, if any.
 * @type {Promise<void> | undefined}
 */
let saving;

/** @param {string} selector */
function element(selector) {
  return /** @type {HTMLElement} */ (document.querySelector(selector));
}

/** @param {Note} note */
function title(note) {
  return note.body.split("\n")[0].trim() || "Untitled";
}

/** @param {string} text */
function show(text) {
  status.textContent = text;
}

function render() {
  list.replaceChildren(
    ...notes.map((note) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = title(note);
      if (note.id === current?.id) button.setAttribute("aria-current", "true");
      button.onclick = () => void open(note.id);
      const item = document.createElement("li");
      item.append(button);
      return item;
    }),
  );
  for (const control of [editor, saveButton, deleteButton]) control.hidden = !current;
  empty.hidden = !!current;
}

/** Fetches the list again; the open note keeps its object, so a save in flight updates it. */
async function load() {
  const fresh = /** @type {Note[]} */ (await invoke("list_notes"));
  notes = fresh.map((note) => (current && note.id === current.id ? Object.assign(current, note) : note));
  if (current && !notes.includes(current)) current = undefined;
  render();
}

/** @param {number} id */
async function open(id) {
  await saveNow();
  current = notes.find((note) => note.id === id);
  editor.value = current?.body ?? "";
  show("");
  render();
  editor.focus();
}

function saveNow() {
  clearTimeout(autosave);
  return save();
}

async function save() {
  // One save at a time: another waits for it, then saves the newest text on top of the revision it made.
  while (saving) await saving;
  const note = current;
  const body = editor.value;
  if (!note || body === note.body) return;
  show("Saving…");
  saving = invoke("save_note", { id: note.id, body, baseRev: note.rev })
    .then(
      (saved) => {
        Object.assign(note, saved);
        if (note === current) show("Saved");
        render();
      },
      (err) => {
        if (note === current) show(String(err));
      },
    )
    .finally(() => {
      saving = undefined;
    });
  await saving;
}

editor.addEventListener("input", () => {
  clearTimeout(autosave);
  autosave = setTimeout(() => void save(), AUTOSAVE_MS);
});

saveButton.addEventListener("click", () => void saveNow());

newButton.addEventListener("click", async () => {
  await saveNow();
  const note = /** @type {Note} */ (await invoke("create_note"));
  await load();
  await open(note.id);
});

deleteButton.addEventListener("click", async () => {
  const note = current;
  if (!note) return;
  clearTimeout(autosave);
  await invoke("delete_note", { id: note.id });
  current = undefined;
  editor.value = "";
  show("Moved to the trash");
  await load();
});

// Another window made or deleted a note.
void listen("notes-changed", () => void load());
void load();
