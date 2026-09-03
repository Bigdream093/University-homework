import { ref } from 'vue'

// 折叠卡片通用状态：默认全部收起，toggle 记录展开的卡片 id。
export function useCollapse() {
  const expanded = ref(new Set())
  function toggle(id) {
    expanded.value.has(id) ? expanded.value.delete(id) : expanded.value.add(id)
  }
  function isOpen(id) {
    return expanded.value.has(id)
  }
  return { expanded, toggle, isOpen }
}
