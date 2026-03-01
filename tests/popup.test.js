describe('Popup script', () => {
  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = `
      <input id="showName" />
      <button id="addBtn">Add</button>
      <div id="blacklist"></div>
    `;

    global.chrome = {
      storage: {
        local: {
          get: jest.fn().mockResolvedValue({ blacklist: ['<img src=x onerror=1>'] }),
          set: jest.fn().mockResolvedValue(undefined)
        }
      }
    };
  });

  test('renders blacklist items as text, not HTML', async () => {
    require('../popup.js');

    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
    await Promise.resolve();

    const blacklistContainer = document.getElementById('blacklist');
    expect(blacklistContainer.querySelector('img')).toBeNull();
    expect(blacklistContainer.textContent).toContain('<img src=x onerror=1>');
  });
});
