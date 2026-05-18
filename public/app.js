const serviceGrid = document.querySelector('#serviceGrid');
const template = document.querySelector('#serviceCardTemplate');
const form = document.querySelector('#serviceForm');
const message = document.querySelector('#formMessage');
const totalCount = document.querySelector('#totalCount');
const searchInput = document.querySelector('#searchInput');
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
  syncQueryToAddressBar(searchInput.value.trim());
  const visible = services.filter((service) => {
    return [service.name, service.path, service.description, service.url, String(service.port)]
      .join(' ')
      .toLowerCase()
      .includes(query);
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
    node.querySelector('h3').textContent = `${service.name} :${service.port}`;
    node.querySelector('.status-text').textContent = service.status;
    const url = node.querySelector('.url');
    url.textContent = service.url;
    url.href = service.url;
    node.querySelector('.path').textContent = service.path || '未记录路径';
    node.querySelector('.description').textContent = service.description || '';

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

    serviceGrid.append(node);
  }
}

async function loadServices() {
  const payload = await api('/api/services');
  services = payload.services;
  render();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const service = {
    name: data.get('name'),
    port: Number(data.get('port')),
    path: data.get('path'),
    status: data.get('status'),
    tags: String(data.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
    description: data.get('description')
  };

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

searchInput.value = getInitialQuery();
loadServices().catch((error) => setMessage(error.message, 'error'));
