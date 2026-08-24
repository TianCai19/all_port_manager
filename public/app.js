const serviceGrid = document.querySelector('#serviceGrid');
const template = document.querySelector('#serviceCardTemplate');
const form = document.querySelector('#serviceForm');
const message = document.querySelector('#formMessage');
const totalCount = document.querySelector('#totalCount');
const searchInput = document.querySelector('#searchInput');
const kindFilter = document.querySelector('#kindFilter');
const refreshButton = document.querySelector('#refreshButton');
const suggestButton = document.querySelector('#suggestButton');

let services = [];

function getInitialQuery() {
  return new URLSearchParams(window.location.search).get('q') || '';
}

function syncQueryToAddressBar(query) {
  const url = new URL(window.location.href);
  if (query) {
    url.searchParams.set('q', query);
  } else {
    url.searchParams.delete('q');
  }
  window.history.replaceState({}, '', url);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || 'request failed');
    error.payload = payload;
    throw error;
  }
  return payload;
}

function setMessage(text, type = 'info') {
  message.textContent = text;
  message.dataset.type = type;
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const activeKind = kindFilter.value;
  syncQueryToAddressBar(searchInput.value.trim());
  const visible = services.filter((service) => {
    const queryMatch = [service.name, service.path, service.description, service.comment, service.url, service.remoteUrl, String(service.port)]
      .join(' ')
      .toLowerCase()
      .includes(query);
    const kindMatch = !activeKind || service.kind === activeKind;
    return queryMatch && kindMatch;
  });

  totalCount.textContent = services.length;
  serviceGrid.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = services.length === 0 ? '还没有注册服务。先登记一个项目吧。' : '没有匹配的服务。';
    serviceGrid.append(empty);
    return;
  }

  for (const service of visible) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.status = service.status;
    node.dataset.kind = service.kind;
    node.querySelector('.kind-badge').textContent = service.kind === 'remote' ? 'remote' : 'local';
    const autostartBadge = node.querySelector('.autostart-badge');
    if (autostartBadge) {
      autostartBadge.style.display = service.autostart ? 'inline' : 'none';
    }
    node.querySelector('h3').textContent = service.kind === 'remote'
      ? service.name
      : `${service.name} :${service.port}`;
    node.querySelector('.status-text').textContent = service.status;
    const url = node.querySelector('.url');
    url.textContent = service.url;
    url.href = service.url;
    node.querySelector('.path').textContent = service.path || (service.kind === 'remote' ? '未记录来源链接' : '未记录路径');
    node.querySelector('.description').textContent = service.description || '';
    if (service.startupCommand && !node.querySelector('.startup-command')) {
      const startupLine = document.createElement('p');
      startupLine.className = 'startup-command';
      startupLine.textContent = `▶ ${service.startupCommand}`;
      node.querySelector('.description').after(startupLine);
    }
    const commentForm = node.querySelector('.comment-form');
    const commentInput = commentForm.elements.comment;
    commentInput.value = service.comment || '';

    const quickActions = node.querySelector('.quick-actions');
    if (service.kind === 'remote' || !service.path) {
      quickActions.hidden = true;
    }

    const tags = node.querySelector('.tags');
    for (const tag of service.tags || []) {
      const tagNode = document.createElement('span');
      tagNode.className = 'tag';
      tagNode.textContent = tag;
      tags.append(tagNode);
    }

    node.querySelector('.delete-button').addEventListener('click', async () => {
      await api(`/api/services/${encodeURIComponent(service.id)}`, { method: 'DELETE' });
      await loadServices();
      setMessage(`已删除 ${service.name}`, 'info');
    });

    node.querySelector('.open-vscode-button').addEventListener('click', () => openProjectPath(service, 'vscode'));
    node.querySelector('.open-terminal-button').addEventListener('click', () => openProjectPath(service, 'terminal'));

    commentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await saveComment(service, commentInput.value);
    });

    serviceGrid.append(node);
  }
}

async function loadServices() {
  const payload = await api('/api/services');
  services = payload.services;
  render();
}

function syncFormMode() {
  const kind = form.elements.kind.value;
  const isRemote = kind === 'remote';
  form.dataset.kind = kind;
  form.elements.port.disabled = isRemote;
  form.elements.port.required = !isRemote;
  form.elements.remoteUrl.disabled = !isRemote;
  form.elements.remoteUrl.required = isRemote;
  suggestButton.disabled = isRemote;

  if (isRemote) {
    form.elements.port.value = '';
    form.elements.path.placeholder = '来源路径 / 控制台地址，例如 https://vercel.com/...';
    form.elements.description.placeholder = '备注，例如 production deployment';
  } else {
    form.elements.remoteUrl.value = '';
    form.elements.path.placeholder = '项目路径 /Users/...';
    form.elements.description.placeholder = '备注';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const kind = data.get('kind');
  const service = {
    kind,
    name: data.get('name'),
    path: data.get('path'),
    status: data.get('status'),
    startupCommand: data.get('startupCommand'),
    autostart: data.get('autostart') === 'on',
    tags: String(data.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
    description: data.get('description'),
    comment: data.get('comment')
  };

  if (kind === 'remote') {
    service.remoteUrl = data.get('remoteUrl');
  } else {
    service.port = Number(data.get('port'));
  }

  try {
    const payload = await api('/api/services', {
      method: 'POST',
      body: JSON.stringify(service)
    });
    form.reset();
    await loadServices();
    setMessage(`已注册 ${payload.service.name}，入口 ${payload.service.url}`, 'success');
  } catch (error) {
    const details = error.payload?.availability;
    const hint = details?.service ? `，已被 ${details.service.name} 注册` : details?.listening ? '，系统已有进程监听' : '';
    setMessage(`${error.message}${hint}`, 'error');
  }
});

async function openProjectPath(service, target) {
  try {
    await api(`/api/services/${encodeURIComponent(service.id)}/open`, {
      method: 'POST',
      body: JSON.stringify({ target })
    });
    setMessage(`已用 ${target === 'vscode' ? 'VS Code' : '终端'} 打开 ${service.name}`, 'success');
  } catch (error) {
    setMessage(`${service.name} 打开失败：${error.message}`, 'error');
  }
}

async function saveComment(service, comment) {
  try {
    const payload = await api(`/api/services/${encodeURIComponent(service.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ comment })
    });
    const index = services.findIndex((item) => item.id === payload.service.id);
    if (index !== -1) services[index] = payload.service;
    render();
    setMessage(`已保存 ${service.name} 的评论`, 'success');
  } catch (error) {
    setMessage(`${service.name} 评论保存失败：${error.message}`, 'error');
  }
}

suggestButton.addEventListener('click', async () => {
  const payload = await api('/api/ports/suggest?start=3000&end=9999&count=1');
  const port = payload.suggestions[0];
  if (!port) {
    setMessage('没有找到可用端口', 'error');
    return;
  }
  form.elements.port.value = port;
  setMessage(`推荐端口：${port}`, 'success');
});

refreshButton.addEventListener('click', loadServices);
searchInput.addEventListener('input', render);
kindFilter.addEventListener('change', render);
form.elements.kind.addEventListener('change', syncFormMode);

searchInput.value = getInitialQuery();
syncFormMode();
loadServices().catch((error) => setMessage(error.message, 'error'));
