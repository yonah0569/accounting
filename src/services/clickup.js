const BASE_URL = "https://api.clickup.com/api/v2";

class ClickUpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ClickUpError";
    this.status = status;
    this.body = body;
  }
}

async function clickupRequest(pathSegment, { method = "GET", body, retry = 0 } = {}) {
  const apiKey = process.env.CLICKUP_API_KEY;
  if (!apiKey) throw new ClickUpError("CLICKUP_API_KEY is not set", 500);

  const res = await fetch(`${BASE_URL}${pathSegment}`, {
    method,
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && retry < 3) {
    const retryAfter = Number(res.headers.get("Retry-After")) || 2 ** retry;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return clickupRequest(pathSegment, { method, body, retry: retry + 1 });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ClickUpError(data.err || `ClickUp API error (${res.status})`, res.status, data);
  }
  return data;
}

const getTeams = () => clickupRequest("/team");
const getSpaces = (teamId) => clickupRequest(`/team/${teamId}/space?archived=false`);
const getFolders = (spaceId) => clickupRequest(`/space/${spaceId}/folder?archived=false`);
const getFolderlessLists = (spaceId) => clickupRequest(`/space/${spaceId}/list?archived=false`);
const getListsInFolder = (folderId) => clickupRequest(`/folder/${folderId}/list?archived=false`);
const getCustomFields = (listId) => clickupRequest(`/list/${listId}/field`);

// Fetches every task in a list (including closed/canceled ones), paginating until exhausted.
async function getAllListTasks(listId) {
  const all = [];
  let page = 0;
  while (true) {
    const data = await clickupRequest(`/list/${listId}/task?page=${page}&include_closed=true`);
    all.push(...data.tasks);
    if (data.last_page) break;
    page += 1;
  }
  return all;
}

const createList = (folderId, name) =>
  clickupRequest(`/folder/${folderId}/list`, { method: "POST", body: { name } });

const createCustomField = (listId, payload) =>
  clickupRequest(`/list/${listId}/field`, { method: "POST", body: payload });

const createTask = (listId, payload) =>
  clickupRequest(`/list/${listId}/task`, { method: "POST", body: payload });

const updateTask = (taskId, payload) =>
  clickupRequest(`/task/${taskId}`, { method: "PUT", body: payload });

const setCustomFieldValue = (taskId, fieldId, value) =>
  clickupRequest(`/task/${taskId}/field/${fieldId}`, { method: "POST", body: { value } });

module.exports = {
  ClickUpError,
  getTeams,
  getSpaces,
  getFolders,
  getFolderlessLists,
  getListsInFolder,
  getCustomFields,
  getAllListTasks,
  createList,
  createCustomField,
  createTask,
  updateTask,
  setCustomFieldValue,
};
