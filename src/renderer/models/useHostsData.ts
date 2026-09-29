/**
 * @author: oldj
 * @homepage: https://oldj.net
 */

import version from '@/version.json'
import { IHostsBasicData, IHostsListObject } from '@common/data'
import { findItemById, updateOneItem } from '@common/hostsFn'
import { actions } from '@renderer/core/agent'
import { currentHostsAtom, hostsDataAtom } from '@renderer/stores/hosts_data'
import { useAtom } from 'jotai'

export default function useHostsData() {
  const [hostsData, setHostsData] = useAtom(hostsDataAtom)
  const [currentHosts, setCurrentHosts] = useAtom(currentHostsAtom)

  const loadHostsData = async () => {
    setHostsData(await actions.getBasicData())
  }

  const setList = async (list: IHostsListObject[]) => {
    list = list.filter((i) => !i.is_sys)

    const data: IHostsBasicData = {
      list,
      trashcan: hostsData.trashcan,
      version,
    }

    setHostsData(data)
    await actions.setList(list)
    await actions.updateTrayTitle()
  }

  // 把刷新后返回的最新节点形态合并回主树（只更新已有节点，不新增）。
  // 关键：手动刷新成功后后端不会广播 reload_list，若不回写主树，
  // 之后任一次 setList 全量保存都会把陈旧的 last_refresh_ms 写回磁盘，
  // 扫描器会误判到期而重复刷新。
  const patchHostsNode = (item: IHostsListObject) => {
    if (!item?.id) return
    setHostsData((prev) => {
      if (!findItemById(prev.list, item.id)) return prev
      return { ...prev, list: updateOneItem(prev.list, item) }
    })
  }

  const isHostsInTrashcan = (id: string): boolean => {
    return hostsData.trashcan.findIndex((i) => i.data.id === id) > -1
  }

  const isReadOnly = (hosts?: IHostsListObject | null): boolean => {
    hosts = hosts || currentHosts

    if (!hosts) {
      return true
    }

    if (hosts.id === '0') {
      return true // system hosts
    }

    if (hosts.type && ['group', 'remote', 'folder', 'trashcan'].includes(hosts.type)) {
      return true
    }

    if (isHostsInTrashcan(hosts.id)) {
      return true
    }

    // ..
    return false
  }

  return {
    hostsData,
    setHostsData,
    loadHostsData,

    setList,

    patchHostsNode,

    currentHosts,
    setCurrentHosts,

    isHostsInTrashcan,
    isReadOnly,
  }
}
