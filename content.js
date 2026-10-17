(() => {
  const HOST_ID = "yjs-batch-host";
  const ARM_THRESHOLD = 30;
  const STATUS_LABEL = {
    ready: "可申请",
    applied: "已申请",
    applying: "投递中",
    external: "外链已跳过",
    map: "需测评",
    resume: "需完善简历",
    login: "需要登录",
    locked: "登录后可投",
    limit: "次数上限",
    unknown: "未确认",
  };

  const state = {
    jobs: new Map(),
    open: false,
    busy: false,
    abort: false,
    query: "",
    hideApplied: true,
    delayMs: 1800,
    armedUntil: 0,
    runningKey: "",
    logs: [],
    panelLeft: 12,
    panelTop: 12,
  };

  const ui = {};

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function textOf(node) {
    return (node?.getAttribute?.("title") || node?.textContent || "").trim();
  }

  function jobPath(href) {
    if (!href) return "";
    try {
      const url = new URL(href, location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return href;
    }
  }

  function sameHref(left, right) {
    if (!left || !right) return false;
    return left === right || jobPath(left) === jobPath(right);
  }

  function buttonByText(root, pattern) {
    return [...root.querySelectorAll("a, button, div, span")].find((node) => {
      const text = (node.innerText || "").replace(/\s/g, "");
      return pattern.test(text) && isVisible(node) && node.children.length === 0;
    });
  }

  function visibleDialogs() {
    return [
      ...document.querySelectorAll(
        ".el-dialog__wrapper, .el-message, .alert-text, .ant-modal-wrap, .ant-message, .dialog-wrap, .dialog-container, .dialog-con",
      ),
    ].filter(isVisible);
  }

  function visibleDialogText() {
    return visibleDialogs()
      .map((node) => node.innerText || "")
      .join("\n");
  }

  function closeDialogContaining(snippet) {
    for (const wrap of visibleDialogs()) {
      if ((wrap.innerText || "").includes(snippet)) {
        const closer = wrap.querySelector(
          ".el-dialog__headerbtn, .ant-modal-close, .dialog-close, .icon-close, .close",
        );
        closer?.click();
        return true;
      }
    }
    return false;
  }

  function clickVisible(selector) {
    const node = [...document.querySelectorAll(selector)].find(isVisible);
    node?.click();
    return Boolean(node);
  }

  function confirmInDialog() {
    for (const wrap of visibleDialogs()) {
      const text = wrap.innerText || "";
      if (!/打招呼|投递|沟通|简历|发送/.test(text)) continue;
      if (/完善简历|去完善|第三方|继续访问/.test(text)) continue;
      const button = [...wrap.querySelectorAll("button, a, .btn")].find((node) => {
        const label = (node.innerText || "").replace(/\s/g, "");
        return /^(确认投递|立即投递|发送|确定)$/.test(label) && isVisible(node);
      });
      if (button) return button;
    }
    return null;
  }

  function dialogOutcome() {
    const text = visibleDialogText();
    if (/请完善简历|完善简历信息|简历未完善|简历不完善/.test(text)) return "resume";
    if (/MAP测评|去测评/.test(text)) return "map";
    if (/即将离开|第三方网站/.test(text)) return "external";
    if (/上限|次数已用完|今日.*沟通|沟通次数/.test(text)) return "limit";
    if (location.pathname.startsWith("/login") || location.pathname.startsWith("/web/user")) return "login";
    if (/验证码登录|请先登录|登录后继续/.test(text) && /手机号|验证码/.test(text)) return "login";
    if (/投递成功|申请成功|发送成功|已向/.test(text)) return "applied";
    return "";
  }

  function clickPager(node) {
    if (!node) return;
    const inner = node.matches("button, a") ? node : node.querySelector("button, a");
    (inner || node).click();
  }

  const yingjiesheng = {
    id: "yingjiesheng",
    label: "应届生",
    match() {
      return location.hostname.includes("yingjiesheng.com");
    },
    shouldOpen() {
      return location.pathname.includes("search");
    },
    hasPager() {
      return Boolean(document.querySelector(".search-list-pagination"));
    },
    getCurrentPage() {
      const active = document.querySelector(".search-list-pagination .el-pager li.active");
      const page = active ? Number.parseInt(active.textContent.trim(), 10) : 1;
      return Number.isFinite(page) && page > 0 ? page : 1;
    },
    pagerButton(kind) {
      return document.querySelector(`.search-list-pagination button.btn-${kind}`);
    },
    canMove(kind) {
      const button = this.pagerButton(kind);
      if (!button) return false;
      return !button.disabled && button.getAttribute("aria-disabled") !== "true" && !button.classList.contains("disabled");
    },
    pageLink(page) {
      return [...document.querySelectorAll(".search-list-pagination .el-pager li.number")].find(
        (item) => Number(item.textContent.trim()) === page,
      );
    },
    readTotalPages() {
      const pager = document.querySelector(".search-list-pagination .el-pagination");
      let vm = pager && pager.__vue__;
      for (let depth = 0; vm && depth < 6; depth += 1) {
        const count = Number(vm.internalPageCount || vm.pageCount || 0);
        if (count > 0) return count;
        const total = Number(vm.totalCount ?? vm.total ?? 0);
        const size = Number(vm.pageSize || vm.$attrs?.["page-size"] || 0);
        if (total > 0 && size > 0) return Math.ceil(total / size);
        vm = vm.$parent;
      }
      const numbers = [...document.querySelectorAll(".search-list-pagination .el-pager li.number")]
        .map((item) => Number.parseInt(item.textContent.trim(), 10))
        .filter((item) => Number.isFinite(item));
      return numbers.length ? Math.max(...numbers) : null;
    },
    pageSignature() {
      const titles = [...document.querySelectorAll(".search-list-item.job .left-title-name .text-cut")]
        .slice(0, 5)
        .map((node) => textOf(node));
      const applied = document.querySelectorAll(".search-list-item.job .hasdelivery").length;
      if (titles.length) return `${titles.join("|")}#${applied}`;
      if (document.querySelector(".search-list-empty")) return "empty";
      return "";
    },
    isListLoading() {
      return [...document.querySelectorAll(".el-loading-mask")].some(isVisible);
    },
    scrapePage() {
      const page = this.getCurrentPage();
      return [...document.querySelectorAll(".search-list-item.job")].map((card, index) => {
        const link = card.closest("a.search-list-href");
        const title = textOf(card.querySelector(".left-title-name .text-cut")) || "未命名岗位";
        const company = textOf(card.querySelector(".left-detail-company"));
        const href = link?.href || "";
        const applied = Boolean(card.querySelector(".hasdelivery"));
        const ready = Boolean(card.querySelector(".notdelivery"));
        return {
          key: href || `${page}::${title}::${company}`,
          title,
          company,
          salary: textOf(card.querySelector(".right-salary")),
          area: textOf(card.querySelector(".left-tag-item")),
          href,
          page,
          index,
          status: applied ? "applied" : ready ? "ready" : "unknown",
          checked: false,
        };
      });
    },
    findCard(job) {
      const link = [...document.querySelectorAll("a.search-list-href")].find(
        (anchor) => sameHref(anchor.href, job.href) && anchor.querySelector(".search-list-item.job"),
      );
      if (link) return link.querySelector(".search-list-item.job");
      return (
        [...document.querySelectorAll(".search-list-item.job")].find((card) => {
          const title = textOf(card.querySelector(".left-title-name .text-cut"));
          const company = textOf(card.querySelector(".left-detail-company"));
          return title === job.title && company === job.company;
        }) || null
      );
    },
    async clickApply(card) {
      const button = card.querySelector(".notdelivery");
      if (!button) return card.querySelector(".hasdelivery") ? "applied" : "unknown";
      card.scrollIntoView({ block: "center", inline: "nearest" });
      button.click();
      const started = Date.now();
      while (Date.now() - started < 9000) {
        if (state.abort) return "unknown";
        const outcome = dialogOutcome();
        if (outcome === "resume") {
          clickVisible(".alert-btn-cancel");
          return "resume";
        }
        if (outcome === "map") {
          clickVisible(".alert-btn-cancel");
          return "map";
        }
        if (outcome === "external") {
          closeDialogContaining("即将离开");
          return "external";
        }
        if (outcome === "limit") return "limit";
        if (outcome === "login") return "login";
        if (outcome === "applied") {
          await sleep(250);
          closeDialogContaining("投递成功");
          closeDialogContaining("申请成功");
          await sleep(300);
          return "applied";
        }
        if (card.querySelector(".hasdelivery") || !card.querySelector(".notdelivery")) {
          await sleep(500);
          closeDialogContaining("投递成功");
          closeDialogContaining("申请成功");
          return "applied";
        }
        await sleep(220);
      }
      return card.querySelector(".hasdelivery") ? "applied" : "unknown";
    },
  };

  const liepin = {
    id: "liepin",
    label: "猎聘",
    match() {
      return location.hostname.includes("liepin.com");
    },
    shouldOpen() {
      return /\/zhaopin|\/job\/|\/career/.test(location.pathname);
    },
    pagerRoot() {
      return (
        document.querySelector(".list-pagination-box .ant-pagination") ||
        document.querySelector(".ant-c-pagination") ||
        document.querySelector(".ant-pagination")
      );
    },
    hasPager() {
      return Boolean(this.pagerRoot());
    },
    pagerItem(kind) {
      const root = this.pagerRoot();
      if (!root) return null;
      return root.querySelector(`.ant-pagination-${kind}, .ant-c-pagination-${kind}`);
    },
    getCurrentPage() {
      const active = this.pagerRoot()?.querySelector(".ant-pagination-item-active, .ant-c-pagination-item-active");
      const page = active ? Number.parseInt(active.getAttribute("title") || active.textContent, 10) : 1;
      return Number.isFinite(page) && page > 0 ? page : 1;
    },
    pagerButton(kind) {
      const item = this.pagerItem(kind);
      return item?.querySelector("button, a") || item;
    },
    canMove(kind) {
      const item = this.pagerItem(kind);
      if (!item) return false;
      const disabled = item.classList.contains("ant-pagination-disabled") || item.classList.contains("ant-c-pagination-disabled");
      return !disabled && item.getAttribute("aria-disabled") !== "true";
    },
    pageLink(page) {
      const item = this.pagerRoot()?.querySelector(`.ant-pagination-item-${page}, .ant-c-pagination-item-${page}`);
      return item?.querySelector("a, button") || item || null;
    },
    readTotalPages() {
      const root = this.pagerRoot();
      if (!root) return null;
      const numbers = [...root.querySelectorAll(".ant-pagination-item, .ant-c-pagination-item")]
        .map((item) => Number.parseInt(item.getAttribute("title") || item.textContent, 10))
        .filter((item) => Number.isFinite(item));
      return numbers.length ? Math.max(...numbers) : null;
    },
    cards() {
      const listed = [...document.querySelectorAll(".job-list-box .jobCardPcContainer")];
      if (listed.length) return listed;
      if (location.hostname.startsWith("c.") || location.pathname.includes("/job/record/")) {
        return [...document.querySelectorAll(".jobCardPcContainer")];
      }
      return [];
    },
    pageSignature() {
      const titles = this.cards()
        .slice(0, 5)
        .map((card) => textOf(card.querySelector(".jobTitleBox > .ellipsis-1, .job-title")));
      if (!titles.length && document.querySelector(".job-apply-container .job-title")) {
        titles.push(textOf(document.querySelector(".job-apply-container .job-title")));
      }
      const applied = document.querySelectorAll(".jobCardPcContainer, .job-apply-container").length
        ? [...document.querySelectorAll(".jobCardPcContainer, .job-apply-container")].filter((card) =>
            /已投递|已沟通|继续聊|停止招聘/.test(card.innerText || ""),
          ).length
        : 0;
      if (titles.length) return `${titles.join("|")}#${applied}`;
      if (/暂无职位|没有找到|暂无投递记录/.test(document.body.innerText || "")) return "empty";
      return "";
    },
    isListLoading() {
      if ([...document.querySelectorAll(".ant-spin-spinning, .searchjobs-spin-loading-box")].some(isVisible)) return true;
      const section = document.querySelector('[class*="list-section"]');
      return Boolean(section && /加载中/.test(section.textContent || ""));
    },
    applyButton(card) {
      const apply = [...card.querySelectorAll('[data-selector="apply-job"]')].find(
        (node) => isVisible(node) && !/已投/.test(node.textContent || ""),
      );
      if (apply) return apply;
      const chat = card.querySelector('.chatBtnBox button, [data-nick="recruiter-info-box-chat-btn"] button');
      if (chat && isVisible(chat) && /^聊一聊$/.test((chat.innerText || "").replace(/\s/g, ""))) return chat;
      return buttonByText(card, /^(聊一聊|立即沟通|投简历)$/);
    },
    applied(card) {
      const acted = [...card.querySelectorAll("a, button")].some((node) =>
        /已投递|已沟通|继续沟通|继续聊/.test((node.innerText || "").replace(/\s/g, "")),
      );
      if (acted) return true;
      return [...card.querySelectorAll("div")].some((node) => node.children.length === 0 && (node.textContent || "").trim() === "停止招聘");
    },
    cardJob(card, page, index) {
      const link = card.querySelector('a[href*="/job/"]');
      const title = textOf(card.querySelector(".jobTitleBox > .ellipsis-1, .job-title")) || "未命名岗位";
      const company = textOf(card.querySelector(".companyName"));
      const salaryNode = [...card.querySelectorAll("span")].find((node) =>
        /\d+\s*k|面议/i.test((node.textContent || "").trim()),
      );
      const area = textOf(card.querySelector(".jobTitleBox .ellipsis-1 + div .ellipsis-1, .jobTitleBox .ellipsis-1 + div"));
      const href = link?.href || "";
      const ready = Boolean(this.applyButton(card));
      return {
        key: jobPath(href) || `${page}::${title}::${company}`,
        title,
        company,
        salary: (salaryNode?.textContent || textOf(card.querySelector(".salary"))).trim(),
        area: area.replace(/[【】]/g, ""),
        href,
        page,
        index,
        status: this.applied(card) ? "applied" : ready ? "ready" : "locked",
        checked: false,
      };
    },
    scrapePage() {
      const page = this.getCurrentPage();
      const cards = this.cards();
      if (cards.length) return cards.map((card, index) => this.cardJob(card, page, index));
      const detail = document.querySelector(".job-apply-container");
      if (!detail) return [];
      const job = this.cardJob(detail, page, 0);
      job.company = textOf(document.querySelector(".company-card .name, .company-header .name")) || job.company;
      job.href = location.href;
      job.key = jobPath(location.href);
      return [job];
    },
    findCard(job) {
      const cards = this.cards();
      const matched = cards.find((card) => {
        const link = card.querySelector('a[href*="/job/"]');
        return sameHref(link?.href, job.href);
      });
      if (matched) return matched;
      const detail = document.querySelector(".job-apply-container");
      if (detail && sameHref(location.href, job.href)) return detail;
      return (
        cards.find((card) => {
          const title = textOf(card.querySelector(".jobTitleBox > .ellipsis-1, .job-title"));
          const company = textOf(card.querySelector(".companyName"));
          return title === job.title && company === job.company;
        }) || null
      );
    },
    async clickApply(card) {
      const button = this.applyButton(card);
      if (!button) return this.applied(card) ? "applied" : "locked";
      card.scrollIntoView({ block: "center", inline: "nearest" });
      button.click();
      return settleGeneric(card, () => this.applied(card) || !this.applyButton(card));
    },
  };

  const zhipin = {
    id: "zhipin",
    label: "BOSS直聘",
    match() {
      return location.hostname.includes("zhipin.com");
    },
    shouldOpen() {
      return /\/web\/geek|\/job_detail|^\/[a-z-]+\/?$/.test(location.pathname);
    },
    pagerRoot() {
      return document.querySelector(".options-pages, .pagination-area .options-pages, .page-box");
    },
    hasPager() {
      return Boolean(this.pagerRoot());
    },
    getCurrentPage() {
      const active = this.pagerRoot()?.querySelector("a.selected, a.current, a.active, .selected, .current");
      const page = active ? Number.parseInt(active.textContent.trim(), 10) : 1;
      return Number.isFinite(page) && page > 0 ? page : 1;
    },
    pagerButton(kind) {
      const root = this.pagerRoot();
      if (!root) return null;
      if (kind === "next") return root.querySelector("a.next, a[ka='page-next'], .next");
      return root.querySelector("a.prev, a[ka='page-prev'], .prev");
    },
    canMove(kind) {
      const button = this.pagerButton(kind);
      if (!button) return false;
      return !button.classList.contains("disabled") && button.getAttribute("aria-disabled") !== "true";
    },
    pageLink(page) {
      const root = this.pagerRoot();
      if (!root) return null;
      return [...root.querySelectorAll("a")].find((item) => Number(item.textContent.trim()) === page) || null;
    },
    readTotalPages() {
      const root = this.pagerRoot();
      if (!root) return null;
      const numbers = [...root.querySelectorAll("a")]
        .map((item) => Number.parseInt(item.textContent.trim(), 10))
        .filter((item) => Number.isFinite(item));
      return numbers.length ? Math.max(...numbers) : null;
    },
    cards() {
      const modern = [...document.querySelectorAll(".job-card-wrapper, .job-card-box, .job-card-wrap")];
      if (modern.length) return modern;
      const plain = [...document.querySelectorAll("a.job-info")].map((anchor) => anchor.closest("li") || anchor);
      if (plain.length) return plain;
      const banner = document.querySelector(".job-banner, .job-detail, .job-box");
      return banner ? [banner] : [];
    },
    applyButton(card) {
      return buttonByText(card, /^(立即沟通|立即投递)$/);
    },
    applied(card) {
      return Boolean(buttonByText(card, /^(继续沟通|已沟通)$/));
    },
    pageSignature() {
      const titles = this.cards()
        .slice(0, 5)
        .map((card) => textOf(card.querySelector(".job-name, .name, h1")));
      const applied = this.cards().filter((card) => this.applied(card)).length;
      if (titles.filter(Boolean).length) return `${titles.join("|")}#${applied}`;
      if (/没有找到相关职位|暂无职位/.test(document.body.innerText || "")) return "empty";
      return "";
    },
    isListLoading() {
      return [...document.querySelectorAll(".loading-wait, .job-loading, .el-loading-mask")].some(isVisible);
    },
    scrapePage() {
      const page = this.getCurrentPage();
      return this.cards().map((card, index) => {
        const link = card.matches("a.job-info") ? card : card.querySelector("a[href*='job_detail'], a.job-card-left, a.job-info");
        const title = textOf(card.querySelector(".job-name, .name, h1")) || "未命名岗位";
        const company = textOf(card.querySelector(".company-name, .boss-name"));
        const href = link?.href || (location.pathname.includes("job_detail") ? location.href : "");
        const ready = Boolean(this.applyButton(card));
        return {
          key: jobPath(href) || `${page}::${title}::${company}`,
          title,
          company,
          salary: textOf(card.querySelector(".salary, .job-salary")),
          area: textOf(card.querySelector(".job-area, .job-text span")),
          href,
          page,
          index,
          status: this.applied(card) ? "applied" : ready ? "ready" : "locked",
          checked: false,
        };
      });
    },
    findCard(job) {
      return (
        this.cards().find((card) => {
          const link = card.matches("a.job-info") ? card : card.querySelector("a[href*='job_detail'], a.job-card-left, a.job-info");
          if (sameHref(link?.href, job.href)) return true;
          return textOf(card.querySelector(".job-name, .name, h1")) === job.title;
        }) || null
      );
    },
    async clickApply(card) {
      const button = this.applyButton(card);
      if (!button) return this.applied(card) ? "applied" : "locked";
      card.scrollIntoView({ block: "center", inline: "nearest" });
      button.click();
      return settleGeneric(card, () => this.applied(card) || !this.applyButton(card));
    },
  };

  const sites = [yingjiesheng, liepin, zhipin];

  function adapter() {
    return sites.find((site) => site.match()) || yingjiesheng;
  }

  async function settleGeneric(card, done) {
    const started = Date.now();
    while (Date.now() - started < 9000) {
      if (state.abort) return "unknown";
      const outcome = dialogOutcome();
      if (outcome === "resume" || outcome === "map") {
        clickVisible(".alert-btn-cancel, .ant-btn-default, .dialog-close");
        return outcome === "map" ? "map" : "resume";
      }
      if (outcome === "external") {
        closeDialogContaining("即将离开");
        return "external";
      }
      if (outcome === "limit") return "limit";
      if (outcome === "login") return "login";
      const confirm = confirmInDialog();
      if (confirm) {
        confirm.click();
        await sleep(450);
        continue;
      }
      if (outcome === "applied" || done()) {
        await sleep(350);
        closeDialogContaining("投递成功");
        closeDialogContaining("申请成功");
        closeDialogContaining("发送成功");
        return "applied";
      }
      await sleep(220);
    }
    return done() ? "applied" : "unknown";
  }

  function getCurrentPage() {
    return adapter().getCurrentPage();
  }

  function pagerButton(kind) {
    return adapter().pagerButton(kind);
  }

  function canMove(kind) {
    return adapter().canMove(kind);
  }

  function readTotalPages() {
    return adapter().readTotalPages();
  }

  function pageSignature() {
    return adapter().pageSignature();
  }

  function isListLoading() {
    return adapter().isListLoading();
  }

  function scrapePage() {
    return adapter().scrapePage();
  }

  function findCard(job) {
    return adapter().findCard(job);
  }

  function clickApply(card) {
    return adapter().clickApply(card);
  }

  function rememberJob(job) {
    const previous = state.jobs.get(job.key);
    const sticky = previous && ["map", "external", "resume", "limit", "locked"].includes(previous.status) && job.status === "ready";
    state.jobs.set(job.key, {
      ...job,
      status: sticky && previous.status !== "locked" ? previous.status : job.status,
      checked: job.status === "applied" ? false : Boolean(previous?.checked),
    });
  }

  function replaceCurrentPage() {
    const page = getCurrentPage();
    const fresh = scrapePage();
    const freshKeys = new Set(fresh.map((job) => job.key));
    for (const [key, job] of state.jobs) {
      if (job.page === page && !freshKeys.has(key)) state.jobs.delete(key);
    }
    fresh.forEach((job) => rememberJob(job));
    renderList();
  }

  function matchesFilter(job) {
    if (state.hideApplied && job.status === "applied") return false;
    const query = state.query.trim().toLowerCase();
    if (!query) return true;
    return `${job.title}\n${job.company}\n${job.area}\n${job.salary}`.toLowerCase().includes(query);
  }

  function sortedJobs() {
    return [...state.jobs.values()].sort((a, b) => a.page - b.page || a.index - b.index);
  }

  function checkedJobs() {
    return sortedJobs().filter((job) => job.checked);
  }

  function clampPanelPos() {
    const width = Math.min(372, window.innerWidth - 24);
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - 280);
    state.panelLeft = Math.min(Math.max(8, state.panelLeft), maxLeft);
    state.panelTop = Math.min(Math.max(8, state.panelTop), maxTop);
  }

  function applyHostBox(host) {
    if (!host) return;
    const base = "display:block;position:fixed;z-index:2147483646;margin:0;padding:0;border:0;background:transparent;color:#221c16;font-size:16px;line-height:normal;";
    if (!state.open) {
      const launcherLeft = Math.min(Math.max(8, state.panelLeft), Math.max(8, window.innerWidth - 80));
      host.style.cssText = `${base}overflow:visible;left:${launcherLeft}px;bottom:16px;width:64px;height:64px;`;
      return;
    }
    clampPanelPos();
    const width = Math.min(372, window.innerWidth - 24);
    const height = Math.max(280, Math.min(window.innerHeight - 24, window.innerHeight - state.panelTop - 12));
    host.style.cssText = `${base}overflow:hidden;contain:layout paint;top:${Math.round(state.panelTop)}px;left:${Math.round(state.panelLeft)}px;width:${Math.round(width)}px;height:${Math.round(height)}px;`;
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function pushLog(text) {
    state.logs.unshift(text);
    state.logs = state.logs.slice(0, 8);
    if (!ui.log) return;
    ui.log.replaceChildren();
    state.logs.forEach((line) => ui.log.append(el("div", "", line)));
  }

  function setBusy(busy) {
    state.busy = busy;
    ui.panel?.querySelectorAll("button.tiny, button.go, input").forEach((node) => {
      node.disabled = busy;
    });
    if (ui.stop) ui.stop.disabled = !busy;
  }

  async function waitForPage(targetPage, previousSignature) {
    const started = Date.now();
    let stableAt = 0;
    let stableSig = "";
    while (Date.now() - started < 15000) {
      if (state.abort) return false;
      const page = getCurrentPage();
      const signature = pageSignature();
      if (page === targetPage && signature && !isListLoading()) {
        if (signature !== previousSignature) {
          if (signature !== stableSig) {
            stableSig = signature;
            stableAt = Date.now();
          } else if (Date.now() - stableAt > 350) {
            return true;
          }
        } else if (Date.now() - started > 1600) {
          return true;
        }
      }
      await sleep(200);
    }
    return getCurrentPage() === targetPage && Boolean(pageSignature());
  }

  async function waitForList() {
    const started = Date.now();
    while (Date.now() - started < 12000) {
      if (state.abort) return false;
      if (pageSignature()) return true;
      await sleep(200);
    }
    return Boolean(pageSignature());
  }

  async function gotoPage(target) {
    const pageNumber = Number(target);
    if (!pageNumber || pageNumber < 1) return false;
    if (getCurrentPage() === pageNumber) return waitForList();

    for (let step = 0; step < 80; step += 1) {
      if (state.abort) return false;
      const current = getCurrentPage();
      if (current === pageNumber && pageSignature()) return true;
      const signature = pageSignature();
      const exact = adapter().pageLink(pageNumber);
      let expect = pageNumber;
      if (exact && !exact.classList.contains("active") && !exact.classList.contains("selected") && !exact.classList.contains("ant-pagination-item-active")) {
        clickPager(exact);
      } else if (pageNumber > current && canMove("next")) {
        clickPager(pagerButton("next"));
        expect = current + 1;
      } else if (pageNumber < current && canMove("prev")) {
        clickPager(pagerButton("prev"));
        expect = current - 1;
      } else {
        return current === pageNumber && Boolean(pageSignature());
      }
      const moved = await waitForPage(expect, signature);
      if (!moved) return getCurrentPage() === pageNumber;
    }
    return getCurrentPage() === pageNumber;
  }

  function absorbPage(seenKeys) {
    scrapePage().forEach((job) => {
      rememberJob(job);
      seenKeys.add(job.key);
    });
  }

  async function crawlAllPages() {
    const seenPages = new Set();
    const seenKeys = new Set();
    let complete = false;
    if (!adapter().hasPager()) {
      const ready = await waitForList();
      if (!ready) {
        setStatus("这一页没有岗位列表。");
        return false;
      }
      let stale = 0;
      for (let guard = 0; guard < 40; guard += 1) {
        if (state.abort) break;
        const before = state.jobs.size;
        absorbPage(seenKeys);
        setStatus(`${adapter().label}已收集 ${state.jobs.size} 个岗位`);
        renderList();
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(1100);
        absorbPage(seenKeys);
        if (state.jobs.size === before) stale += 1;
        else stale = 0;
        if (stale >= 2) {
          complete = true;
          break;
        }
      }
    } else {
      const back = await gotoPage(1);
      if (!back) {
        setStatus(getCurrentPage() === 1 ? "这一页没有岗位列表。" : "没有回到第 1 页，先刷新岗位列表再试。");
        return false;
      }
      for (let guard = 0; guard < 200; guard += 1) {
        if (state.abort) break;
        await waitForList();
        const page = getCurrentPage();
        if (seenPages.has(page)) break;
        seenPages.add(page);
        absorbPage(seenKeys);
        const total = readTotalPages();
        setStatus(
          total
            ? `${adapter().label}正在读取第 ${page}/${total} 页，已收集 ${state.jobs.size} 个岗位`
            : `${adapter().label}正在读取第 ${page} 页，已收集 ${state.jobs.size} 个岗位`,
        );
        renderList();
        if (!canMove("next")) {
          complete = true;
          break;
        }
        const signature = pageSignature();
        clickPager(pagerButton("next"));
        const moved = await waitForPage(page + 1, signature);
        if (!moved) break;
      }
    }
    if (complete) {
      for (const key of state.jobs.keys()) {
        if (!seenKeys.has(key)) state.jobs.delete(key);
      }
    }
    setStatus(
      state.abort
        ? `已停止读取，目前收集 ${state.jobs.size} 个岗位。`
        : `读取完成，共 ${state.jobs.size} 个岗位。`,
    );
    renderList();
    return complete && !state.abort;
  }

  async function applyChecked() {
    const targets = checkedJobs().filter((job) => job.status !== "applied" && job.status !== "locked");
    if (!targets.length) {
      setStatus("还没有勾选可投递的岗位。");
      return;
    }
    if (targets.length > ARM_THRESHOLD && Date.now() > state.armedUntil) {
      state.armedUntil = Date.now() + 8000;
      setStatus(`已勾选 ${targets.length} 个。8 秒内再点一次「投递已勾选」才会开始。`);
      return;
    }
    state.armedUntil = 0;
    state.abort = false;
    setBusy(true);
    let done = 0;
    let success = 0;
    try {
      const pages = [...new Set(targets.map((job) => job.page))].sort((a, b) => a - b);
      for (const page of pages) {
        if (state.abort) break;
        setStatus(`正在打开第 ${page} 页`);
        const opened = adapter().hasPager() ? await gotoPage(page) : true;
        if (!opened) {
          pushLog(`第 ${page} 页没有打开，这一页先跳过`);
          continue;
        }
        const batch = targets.filter((job) => job.page === page);
        for (const job of batch) {
          if (state.abort) break;
          done += 1;
          state.runningKey = job.key;
          job.status = "applying";
          renderList();
          setStatus(`正在投递 ${done}/${targets.length} · 第 ${page} 页 · ${job.title}`);
          const card = findCard(job);
          closeDialogContaining("投递成功");
          closeDialogContaining("申请成功");
          closeDialogContaining("即将离开");
          const result = card ? await clickApply(card) : "unknown";
          job.status = result;
          if (result === "applied") {
            success += 1;
            job.checked = false;
            pushLog(`已申请 · ${job.title}`);
          } else if (result === "resume") {
            job.checked = false;
            pushLog(`简历未完善，批量已停下 · ${job.title}`);
            setStatus("简历信息不完整。先去完善简历，再回来继续投递。");
            state.abort = true;
          } else if (result === "login") {
            pushLog("需要登录，批量已停下");
            setStatus("这个操作需要登录。登录后再继续。");
            state.abort = true;
          } else if (result === "limit") {
            job.checked = false;
            pushLog(`次数到上限，批量已停下 · ${job.title}`);
            setStatus("站点提示次数已达上限，先停一下。");
            state.abort = true;
          } else if (result === "map") {
            job.checked = false;
            pushLog(`这家要测评，已跳过 · ${job.title}`);
          } else if (result === "external") {
            job.checked = false;
            pushLog(`外链岗位已跳过 · ${job.title}`);
          } else if (result === "locked") {
            job.checked = false;
            pushLog(`没有可点的申请按钮 · ${job.title}`);
          } else {
            pushLog(`没有确认成功，可稍后重试 · ${job.title}`);
          }
          renderList();
          if (state.abort) break;
          await sleep(state.delayMs);
        }
      }
    } finally {
      state.runningKey = "";
      setBusy(false);
      renderList();
      if (!state.abort) setStatus(`本轮结束。确认申请 ${success} 个，处理 ${done} 个。`);
      else if (success) setStatus(`已停止。确认申请 ${success} 个。`);
    }
  }

  function selectCurrentPage(checked) {
    replaceCurrentPage();
    const page = getCurrentPage();
    for (const job of state.jobs.values()) {
      if (job.page === page && matchesFilter(job) && job.status === "ready") job.checked = checked;
    }
    renderList();
    setStatus(checked ? "已勾选当前页里能申请的岗位。" : "已取消当前页勾选。");
  }

  async function selectAllPages() {
    if (state.busy) return;
    state.abort = false;
    setBusy(true);
    try {
      const loaded = await crawlAllPages();
      if (!loaded || state.abort) return;
      for (const job of state.jobs.values()) {
        job.checked = matchesFilter(job) && job.status === "ready";
      }
      renderList();
      const picked = checkedJobs().length;
      setStatus(
        state.query.trim()
          ? `已按「${state.query.trim()}」勾选 ${picked} 个可申请岗位。点「投递已勾选」开始。`
          : `已勾选全部页面中 ${picked} 个可申请岗位。点「投递已勾选」开始。`,
      );
    } finally {
      setBusy(false);
    }
  }

  function badgeClass(status) {
    if (status === "ready") return "badge";
    if (status === "applied" || status === "locked") return "badge mute";
    return "badge warn";
  }

  function renderList() {
    if (!ui.list) return;
    const scrollTop = ui.list.scrollTop;
    const jobs = sortedJobs().filter(matchesFilter);
    const page = getCurrentPage();
    const checked = [...state.jobs.values()].filter((job) => job.checked).length;
    ui.stats.textContent = `${adapter().label} · 本页 ${[...state.jobs.values()].filter((job) => job.page === page).length} · 已加载 ${state.jobs.size} · 显示 ${jobs.length} · 已勾选 ${checked}`;
    ui.apply.textContent = `投递已勾选${checked ? `（${checked}）` : ""}`;
    ui.list.replaceChildren();
    if (!jobs.length) {
      const loaded = state.jobs.size;
      const empty = el(
        "div",
        "empty",
        location.pathname.startsWith("/login") || location.pathname.startsWith("/web/user")
          ? "当前是登录页。登录后打开职位列表，面板会读出标题。"
          : loaded
            ? `已读取 ${loaded} 个职位，当前筛选下没有要显示的。`
            : "这一页还没读到岗位。列表出来后点「刷新本页」。",
      );
      ui.list.append(empty);
      return;
    }

    let lastPage = 0;
    const showGroups = new Set(jobs.map((job) => job.page)).size > 1;
    jobs.forEach((job) => {
      if (showGroups && job.page !== lastPage) {
        lastPage = job.page;
        ui.list.append(el("div", "group", `第 ${job.page} 页`));
      }
      const row = el("label", `row${job.checked ? " is-on" : ""}${job.key === state.runningKey ? " is-running" : ""}`);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = job.checked;
      box.disabled = state.busy || job.status === "applied" || job.status === "locked";
      box.addEventListener("change", () => {
        job.checked = box.checked;
        row.classList.toggle("is-on", job.checked);
        const nextChecked = [...state.jobs.values()].filter((item) => item.checked).length;
        ui.stats.textContent = `${adapter().label} · 本页 ${[...state.jobs.values()].filter((item) => item.page === page).length} · 已加载 ${state.jobs.size} · 显示 ${jobs.length} · 已勾选 ${nextChecked}`;
        ui.apply.textContent = `投递已勾选${nextChecked ? `（${nextChecked}）` : ""}`;
      });
      const body = el("div");
      const title = el("p", "title", job.title);
      title.append(el("em", badgeClass(job.status), STATUS_LABEL[job.status] || job.status));
      const meta = el("p", "meta");
      meta.textContent = [job.company, job.area, job.salary].filter(Boolean).join(" · ");
      if (job.href) {
        meta.append(" · ");
        const link = el("a", "", "原文");
        link.href = job.href;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.addEventListener("click", (event) => event.stopPropagation());
        meta.append(link);
      }
      body.append(title, meta);
      row.append(box, body);
      ui.list.append(row);
    });
    ui.list.scrollTop = scrollTop;
  }

  function renderShell(shadow) {
    const style = document.createElement("style");
    shadow.append(style);
    fetch(chrome.runtime.getURL("panel.css"))
      .then((response) => response.text())
      .then((css) => {
        style.textContent = css;
      })
      .catch(() => {
        setStatus("面板样式没有加载出来，刷新页面后再试。");
      });

    const launcher = el("button", "launcher", "投");
    launcher.type = "button";
    launcher.title = "打开批量投递";
    const panel = el("aside", "panel");
    panel.hidden = true;
    panel.title = "按住面板任意处拖动";

    const head = el("div", "head");
    head.append(el("span", "seal", "投"));
    const titles = el("div");
    titles.append(el("h1", "", "批量投递"), el("p", "sub", adapter().label));
    const close = el("button", "ghost", "收起");
    close.type = "button";
    head.append(titles, close);

    const tools = el("div", "tools");
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "筛选标题、公司、城市";
    search.value = state.query;
    const delayWrap = el("label", "delay");
    const delay = document.createElement("input");
    delay.type = "number";
    delay.min = "0.8";
    delay.max = "8";
    delay.step = "0.2";
    delay.value = String(state.delayMs / 1000);
    delay.setAttribute("aria-label", "每次申请间隔，单位秒");
    delayWrap.append(delay, document.createTextNode("秒"));
    tools.append(search, delayWrap);

    const checkline = el("label", "checkline");
    const hide = document.createElement("input");
    hide.type = "checkbox";
    hide.checked = state.hideApplied;
    checkline.append(hide, document.createTextNode("隐藏已申请"));

    const actions = el("div", "actions");
    const refresh = el("button", "tiny", "刷新本页");
    const readAll = el("button", "tiny", "读取全部页");
    const selectPage = el("button", "tiny primary", "全选本页");
    const clearPage = el("button", "tiny", "取消本页");
    const selectAll = el("button", "tiny primary", "全选所有页");
    const clearAll = el("button", "tiny", "清空勾选");
    [refresh, readAll, selectPage, clearPage, selectAll, clearAll].forEach((button) => {
      button.type = "button";
    });
    actions.append(refresh, readAll, selectPage, clearPage, selectAll, clearAll);

    const stats = el("div", "stats", "等待岗位列表");
    const list = el("div", "list");
    const log = el("div", "log");
    const foot = el("div", "foot");
    const apply = el("button", "go", "投递已勾选");
    const stop = el("button", "stop", "停止");
    apply.type = "button";
    stop.type = "button";
    stop.disabled = true;
    foot.append(apply, stop);
    const status = el("div", "status", "打开职位列表后点「刷新本页」。猎聘搜索页点「投简历」或「聊一聊」，应聘记录点「聊一聊」。BOSS直聘点「立即沟通」。");

    panel.append(head, tools, checkline, actions, stats, list, log, foot, status);
    shadow.append(launcher, panel);

    ui.panel = panel;
    ui.launcher = launcher;
    ui.list = list;
    ui.stats = stats;
    ui.log = log;
    ui.apply = apply;
    ui.stop = stop;
    ui.status = status;

    const setOpen = (open) => {
      state.open = open;
      panel.hidden = !open;
      launcher.hidden = open;
      applyHostBox(shadow.host);
    };

    let drag = null;
    let suppressClick = false;
    panel.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag = {
        id: event.pointerId,
        dx: event.clientX - state.panelLeft,
        dy: event.clientY - state.panelTop,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
    });
    panel.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        panel.classList.add("is-dragging");
        panel.setPointerCapture(event.pointerId);
      }
      state.panelLeft = event.clientX - drag.dx;
      state.panelTop = event.clientY - drag.dy;
      applyHostBox(shadow.host);
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      suppressClick = drag.moved;
      drag = null;
      panel.classList.remove("is-dragging");
      if (suppressClick) {
        chrome.storage?.local.set({ panelLeft: state.panelLeft, panelTop: state.panelTop }).catch(() => {});
      }
    };
    panel.addEventListener("pointerup", endDrag);
    panel.addEventListener("pointercancel", endDrag);
    panel.addEventListener(
      "click",
      (event) => {
        if (!suppressClick) return;
        suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );

    launcher.addEventListener("click", () => {
      setOpen(true);
      replaceCurrentPage();
    });
    close.addEventListener("click", () => setOpen(false));
    search.addEventListener("input", () => {
      state.query = search.value;
      renderList();
    });
    delay.addEventListener("change", () => {
      const seconds = Math.min(8, Math.max(0.8, Number(delay.value) || 1.8));
      delay.value = String(seconds);
      state.delayMs = Math.round(seconds * 1000);
      chrome.storage?.local.set({ delayMs: state.delayMs }).catch(() => {});
    });
    hide.addEventListener("change", () => {
      state.hideApplied = hide.checked;
      chrome.storage?.local.set({ hideApplied: state.hideApplied }).catch(() => {});
      renderList();
    });
    refresh.addEventListener("click", () => {
      replaceCurrentPage();
      setStatus(`已刷新${adapter().label}第 ${getCurrentPage()} 页。`);
    });
    readAll.addEventListener("click", async () => {
      if (state.busy) return;
      state.abort = false;
      setBusy(true);
      try {
        await crawlAllPages();
      } finally {
        setBusy(false);
      }
    });
    selectPage.addEventListener("click", () => selectCurrentPage(true));
    clearPage.addEventListener("click", () => selectCurrentPage(false));
    selectAll.addEventListener("click", () => selectAllPages());
    clearAll.addEventListener("click", () => {
      state.jobs.forEach((job) => {
        job.checked = false;
      });
      renderList();
      setStatus("已清空勾选。");
    });
    apply.addEventListener("click", () => applyChecked());
    stop.addEventListener("click", () => {
      state.abort = true;
      setStatus("当前这条结束后停止。");
    });

    setOpen(state.open);
  }

  function shouldOpen() {
    return adapter().shouldOpen();
  }

  async function boot() {
    if (window.__yjsBatchBooted) return;
    window.__yjsBatchBooted = true;
    document.querySelectorAll(`#${HOST_ID}`).forEach((node) => node.remove());
    try {
      const saved = await chrome.storage.local.get({ delayMs: 1800, hideApplied: true, panelLeft: 12, panelTop: 12 });
      state.delayMs = Number(saved.delayMs) || 1800;
      state.hideApplied = saved.hideApplied !== false;
      state.panelLeft = Number.isFinite(Number(saved.panelLeft)) ? Number(saved.panelLeft) : 12;
      state.panelTop = Number.isFinite(Number(saved.panelTop)) ? Number(saved.panelTop) : 12;
    } catch {
      // 存储不可用时继续用默认间隔。
    }

    const host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);
    state.open = shouldOpen();
    renderShell(shadow);
    if (state.open) replaceCurrentPage();

    let lastSignature = `${getCurrentPage()}::${pageSignature()}`;
    const observer = new MutationObserver(() => {
      if (state.busy || !state.open) return;
      const signature = `${getCurrentPage()}::${pageSignature()}`;
      if (!pageSignature() || signature === lastSignature) return;
      lastSignature = signature;
      replaceCurrentPage();
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", () => applyHostBox(document.getElementById(HOST_ID)));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "YJS_TOGGLE_PANEL") return;
    const host = document.getElementById(HOST_ID);
    if (!host) {
      sendResponse({ ok: false });
      return;
    }
    state.open = !state.open;
    const panel = host.shadowRoot?.querySelector(".panel");
    const launcher = host.shadowRoot?.querySelector(".launcher");
    if (panel) panel.hidden = !state.open;
    if (launcher) launcher.hidden = state.open;
    applyHostBox(host);
    if (state.open) replaceCurrentPage();
    sendResponse({ ok: true });
  });

  boot();
})();
