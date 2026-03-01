document.addEventListener('DOMContentLoaded', async () => {
  const showNameInput = document.getElementById('showName');
  const addBtn = document.getElementById('addBtn');
  const blacklistDiv = document.getElementById('blacklist');

  async function loadBlacklist() {
    const result = await chrome.storage.local.get('blacklist');
    const blacklist = result.blacklist || [];
    displayBlacklist(blacklist);
  }

  function displayBlacklist(blacklist) {
    blacklistDiv.textContent = '';

    if (blacklist.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.style.padding = '10px';
      emptyState.style.textAlign = 'center';
      emptyState.style.color = '#999';
      emptyState.textContent = 'No shows blacklisted yet';
      blacklistDiv.appendChild(emptyState);
      return;
    }

    blacklist.forEach((show, index) => {
      const item = document.createElement('div');
      item.className = 'blacklist-item';

      const label = document.createElement('span');
      label.textContent = show;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = 'Remove';
      removeBtn.dataset.index = String(index);
      removeBtn.addEventListener('click', async (e) => {
        const targetIndex = Number(e.currentTarget.dataset.index);
        await removeFromBlacklist(targetIndex);
      });

      item.appendChild(label);
      item.appendChild(removeBtn);
      blacklistDiv.appendChild(item);
    });
  }

  async function addToBlacklist() {
    const showName = showNameInput.value.trim();
    if (!showName) return;

    const result = await chrome.storage.local.get('blacklist');
    const blacklist = result.blacklist || [];
    
    if (!blacklist.includes(showName)) {
      blacklist.push(showName);
      await chrome.storage.local.set({ blacklist });
      showNameInput.value = '';
      loadBlacklist();
    }
  }

  async function removeFromBlacklist(index) {
    const result = await chrome.storage.local.get('blacklist');
    const blacklist = result.blacklist || [];
    blacklist.splice(index, 1);
    await chrome.storage.local.set({ blacklist });
    loadBlacklist();
  }

  addBtn.addEventListener('click', addToBlacklist);
  showNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addToBlacklist();
    }
  });

  await loadBlacklist();
});
