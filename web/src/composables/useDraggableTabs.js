import { nextTick, onMounted, onUnmounted } from 'vue';
import Sortable from 'sortablejs';

/**
 * 让 el-tabs 的选项卡支持鼠标拖拽改变顺序，并把顺序保存到 localStorage。
 * @param {import('vue').Ref<HTMLElement|null>} rootRef 包裹 el-tabs 的模板 ref
 * @param {import('vue').Ref<Array<{label:string,name:string}>>} tabDefs 选项卡定义数组
 * @param {string} storageKey 持久化键（区分教师端/学生端）
 */
export function useDraggableTabs(rootRef, tabDefs, storageKey) {
  const orderKey = `hw:tab-order:${storageKey}`;
  const tabSelector = '.el-tabs__item';

  function loadOrder() {
    try {
      const saved = JSON.parse(localStorage.getItem(orderKey) || '[]');
      if (!Array.isArray(saved) || !saved.length) return;
      const byName = new Map(tabDefs.value.map((def) => [def.name, def]));
      const savedNames = [...new Set(saved)].filter((name) => byName.has(name));
      const ordered = savedNames.map((name) => byName.get(name));
      const missing = tabDefs.value.filter((def) => !savedNames.includes(def.name));
      tabDefs.value.splice(0, tabDefs.value.length, ...ordered, ...missing);
    } catch {
      // localStorage 数据损坏时保持默认顺序
    }
  }

  function saveOrder() {
    try {
      localStorage.setItem(orderKey, JSON.stringify(tabDefs.value.map((def) => def.name)));
    } catch {
      // 忽略存储不可用的情况
    }
  }

  loadOrder();

  let sortable = null;

  /**
   * Sortable 会先直接改变 DOM，而 el-tabs 的真实顺序由 Vue 的 tabDefs 决定。
   * 先把 DOM 放回拖动前的位置，再修改响应式数组，避免 Vue diff 与 Sortable
   * 同时接管同一批节点造成标签跳位或激活条抖动。
   */
  function restoreDomOrder(event) {
    const { from, item, oldDraggableIndex } = event;
    if (!from || !item || oldDraggableIndex == null) return;

    item.remove();
    const tabs = [...from.querySelectorAll(`:scope > ${tabSelector}`)];
    from.insertBefore(item, tabs[oldDraggableIndex] || null);
  }

  onMounted(async () => {
    await nextTick();
    const root = rootRef.value;
    if (!root) return;
    const nav = root.querySelector('.el-tabs__nav');
    if (!nav) return;
    sortable = Sortable.create(nav, {
      // el-tabs__nav 里还包含激活下划线，只允许真实 tab 参与排序。
      draggable: tabSelector,
      direction: 'horizontal',
      animation: 180,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      swapThreshold: 0.65,
      fallbackTolerance: 4,
      delayOnTouchOnly: true,
      delay: 120,
      ghostClass: 'hw-tabs-ghost',
      chosenClass: 'hw-tabs-chosen',
      dragClass: 'hw-tabs-dragging',
      onEnd: (event) => {
        const { oldDraggableIndex, newDraggableIndex } = event;
        if (
          oldDraggableIndex == null ||
          newDraggableIndex == null ||
          oldDraggableIndex === newDraggableIndex
        ) return;

        restoreDomOrder(event);
        const [moved] = tabDefs.value.splice(oldDraggableIndex, 1);
        tabDefs.value.splice(newDraggableIndex, 0, moved);
        saveOrder();
      },
    });
  });

  onUnmounted(() => {
    if (sortable) sortable.destroy();
  });
}
