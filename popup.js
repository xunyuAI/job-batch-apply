const toggle = document.getElementById("toggle");
const message = document.getElementById("message");

toggle.addEventListener("click", async () => {
  message.textContent = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const supported = ["q.yingjiesheng.com", "www.liepin.com", "www.zhipin.com"];
  if (!tab?.id || !supported.some((host) => tab.url?.includes(host))) {
    message.textContent = "请先打开应届生、猎聘或 BOSS直聘的职位页。";
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "YJS_TOGGLE_PANEL" });
    if (!response?.ok) {
      message.textContent = "页面还没挂上面板。刷新求职页后再试。";
    }
  } catch {
    message.textContent = "刷新求职页后再打开面板。刚装好插件时需要刷新一次。";
  }
});
