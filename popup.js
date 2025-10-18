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
    if (blacklist.length === 0) {
      blacklistDiv.innerHTML = '<div style="padding: 10px; text-align: center; color: #999;">No shows blacklisted yet</div>';
      return;
    }

    blacklistDiv.innerHTML = blacklist.map((show, index) => `
      <div class="blacklist-item">
        <span>${show}</span>
        <button class="remove-btn" data-index="${index}">Remove</button>
      </div>
    `).join('');

    document.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const index = parseInt(e.target.dataset.index);
        await removeFromBlacklist(index);
      });
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
