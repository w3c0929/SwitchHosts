/**
 * @author: oldj
 * @homepage: https://oldj.net
 */

import { IHostsHistoryObject } from '@common/data'
import events from '@common/events'
import {
  Box,
  Button,
  Center,
  Flex,
  Group,
  Loader,
  ScrollArea,
  Select,
  Text,
  Tooltip,
} from '@mantine/core'
import ConfirmModal from '@renderer/components/ConfirmModal'
import HostsViewer from '@renderer/components/HostsViewer'
import SideDrawer from '@renderer/components/SideDrawer'
import { actions } from '@renderer/core/agent'
import { showSuccessNotification } from '@renderer/core/notify'
import useOnBroadcast from '@renderer/core/useOnBroadcast'
import useConfigs from '@renderer/models/useConfigs'
import useI18n from '@renderer/models/useI18n'
import { IconFileTime, IconHelpCircle, IconHistory, IconTrash, IconX } from '@tabler/icons-react'
import clsx from 'clsx'
import dayjs from 'dayjs'
import prettyBytes from 'pretty-bytes'
import React, { useRef, useState } from 'react'
import styles from './History.module.scss'

interface IHistoryProps {
  list: IHostsHistoryObject[]
  selectedItem: IHostsHistoryObject | undefined
  selectedIds: string[]
  onItemClick: (item: IHostsHistoryObject, e: React.MouseEvent) => void
}

const HistoryList = (props: IHistoryProps): React.ReactElement => {
  const { list, selectedItem, selectedIds, onItemClick } = props
  const { lang } = useI18n()

  if (list.length === 0) {
    return (
      <Center h="100%" style={{ opacity: 0.5, fontSize: 'var(--mantine-font-size-lg)' }}>
        {lang.no_record}
      </Center>
    )
  }

  return (
    <Flex h="100%" mih={0} style={{ minHeight: 0, overflow: 'hidden' }}>
      <Box
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          marginRight: 12,
          border: '1px solid var(--swh-border-color-0)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <HostsViewer content={selectedItem ? selectedItem.content : ''} />
      </Box>
      <ScrollArea
        w={200}
        h="100%"
        scrollbars="y"
        type="hover"
        style={{
          border: '1px solid var(--swh-border-color-0)',
          borderRadius: 6,
          minHeight: 0,
          padding: 4,
        }}
      >
        {list.map((item) => {
          const isSelected = selectedIds.includes(item.id)
          return (
            <Box
              key={item.id}
              onClick={(e: React.MouseEvent) => onItemClick(item, e)}
              px="12px"
              py="8px"
              style={{ userSelect: 'none', cursor: 'pointer' }}
              className={clsx(
                styles.item,
                (isSelected || item.id === selectedItem?.id) && styles.selected,
              )}
            >
              <Group gap="8px" wrap="nowrap" align="flex-start">
                <Box>
                  <IconFileTime size={16} />
                </Box>
                <Box style={{ minWidth: 0 }}>
                  <Text size="sm">{dayjs(item.add_time_ms).format('YYYY-MM-DD HH:mm:ss')}</Text>
                  <Group
                    gap="8px"
                    style={{
                      lineHeight: '14px',
                      fontSize: 9,
                      opacity: 0.6,
                    }}
                  >
                    <Box>{item.content.split('\n').length} lines</Box>
                    <Box>{prettyBytes(item.content.length)}</Box>
                  </Group>
                </Box>
              </Group>
            </Box>
          )
        })}
      </ScrollArea>
    </Flex>
  )
}

const Loading = () => (
  <Center h="100%">
    <Group gap="12px">
      <Loader size="lg" />
      <Text>Loading...</Text>
    </Group>
  </Center>
)

const History = () => {
  const { configs, updateConfigs } = useConfigs()
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [list, setList] = useState<IHostsHistoryObject[]>([])
  const [selectedItem, setSelectedItem] = useState<IHostsHistoryObject>()
  // 批量选择：Ctrl 多选 / Shift 范围选择 / 普通点击单选
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleteTargets, setDeleteTargets] = useState<IHostsHistoryObject[]>()
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  // Shift 范围选择的锚点（最近一次非 Shift 点击的版本）
  const anchorRef = useRef<string | null>(null)

  const { lang } = useI18n()

  const loadData = async () => {
    setIsLoading(true)
    let nextList = await actions.getHistoryList()
    nextList = nextList.reverse()
    setList(nextList)
    if (!selectedItem) {
      setSelectedItem(nextList[0])
    }
    setIsLoading(false)

    return nextList
  }

  const onClose = () => {
    setIsOpen(false)
    setList([])
    setDeleteTargets(undefined)
    setClearConfirmOpen(false)
    setSelectedIds([])
  }

  const onItemClick = (item: IHostsHistoryObject, e: React.MouseEvent) => {
    const idx = list.findIndex((i) => i.id === item.id)
    const ids = list.map((i) => i.id)

    if (e.shiftKey && anchorRef.current && anchorRef.current !== item.id) {
      // Shift：以锚点为起点，范围选择
      const aIdx = ids.indexOf(anchorRef.current)
      if (aIdx > -1) {
        const [lo, hi] = aIdx < idx ? [aIdx, idx] : [idx, aIdx]
        setSelectedIds(ids.slice(lo, hi + 1))
      } else {
        setSelectedIds([item.id])
      }
      setSelectedItem(item)
      return
    }

    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd：多选（点击项加入/移出选择）
      setSelectedIds((prev) => {
        const has = prev.includes(item.id)
        return has ? prev.filter((x) => x !== item.id) : [...prev, item.id]
      })
      anchorRef.current = item.id
      setSelectedItem(item)
      return
    }

    // 普通点击：单选
    setSelectedIds([item.id])
    anchorRef.current = item.id
    setSelectedItem(item)
  }

  const deleteItems = async (items: IHostsHistoryObject[]) => {
    const ids = items.map((i) => i.id)
    if (ids.length === 0) return
    const first = list.findIndex((i) => i.id === ids[0])

    const success =
      ids.length === 1 ? await actions.deleteHistory(ids[0]) : await actions.deleteHistoryMany(ids)
    if (success === false) return

    setSelectedItem(undefined)
    setSelectedIds([])
    const list2 = await loadData()

    const nextItem = list2[first] || list2[first - 1]
    if (nextItem) {
      setSelectedItem(nextItem)
    }
    showSuccessNotification({ title: lang.delete, message: lang.success })
  }

  const clearAll = async () => {
    try {
      await actions.clearHistory()
    } catch (e) {
      console.error(e)
      return
    }
    setSelectedItem(undefined)
    setSelectedIds([])
    await loadData()
    showSuccessNotification({ title: lang.clear_history, message: lang.success })
  }

  const updateHistoryLimit = async (value: number) => {
    if (!value || value < 0) return
    await updateConfigs({ history_limit: value })
  }

  useOnBroadcast(events.show_history, () => {
    setIsOpen(true)
    loadData().catch((e) => {
      console.error(e)
    })
  })

  const historyLimitValues: number[] = [10, 50, 100, 500]
  if (configs && !historyLimitValues.includes(configs.history_limit)) {
    historyLimitValues.push(configs.history_limit)
    historyLimitValues.sort()
  }

  return (
    <>
      <SideDrawer
        opened={isOpen}
        onClose={onClose}
        size="lg"
        scrollable={false}
        title={
          <Group gap="8px">
            <IconHistory size={16} />
            <Box>{lang.system_hosts_history}</Box>
          </Group>
        }
        footer={
          <Flex align="center" gap="12px">
            <Box>{lang.system_hosts_history_limit}</Box>
            <Select
              data={historyLimitValues.map((v) => v.toString())}
              value={String(configs?.history_limit ?? '')}
              onChange={(v) => updateHistoryLimit(parseInt(v || '0'))}
              w={100}
              allowDeselect={false}
            />
            <Tooltip label={lang.system_hosts_history_help}>
              <Box style={{ display: 'flex' }}>
                <IconHelpCircle size={16} />
              </Box>
            </Tooltip>
            <Box style={{ flex: 1 }} />
            <Button
              variant="outline"
              disabled={list.length === 0}
              onClick={() => setClearConfirmOpen(true)}
              leftSection={<IconTrash size={16} />}
            >
              {lang.clear_history}
            </Button>
            <Button
              variant="outline"
              disabled={selectedIds.length === 0}
              onClick={() => {
                const targets = list.filter((i) => selectedIds.includes(i.id))
                setDeleteTargets(targets)
              }}
              leftSection={<IconX size={16} />}
            >
              {selectedIds.length > 1 ? `${lang.delete} (${selectedIds.length})` : lang.delete}
            </Button>
            <Button onClick={onClose} variant="outline">
              {lang.close}
            </Button>
          </Flex>
        }
      >
        <Box style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
          {isLoading ? (
            <Loading />
          ) : (
            <HistoryList
              list={list}
              selectedItem={selectedItem}
              selectedIds={selectedIds}
              onItemClick={onItemClick}
            />
          )}
        </Box>
      </SideDrawer>

      <ConfirmModal
        opened={!!deleteTargets?.length}
        onClose={() => setDeleteTargets(undefined)}
        onConfirm={() => {
          if (deleteTargets?.length) {
            deleteItems(deleteTargets)
          }
        }}
        title={
          deleteTargets && deleteTargets.length > 1
            ? `${lang.delete} (${deleteTargets.length})`
            : lang.delete
        }
        message={lang.system_hosts_history_delete_confirm}
        confirmLabel={lang.delete}
        danger
      />

      <ConfirmModal
        opened={clearConfirmOpen}
        onClose={() => setClearConfirmOpen(false)}
        onConfirm={() => {
          clearAll()
        }}
        title={lang.clear_history}
        message={lang.system_hosts_history_clear_confirm}
        confirmLabel={lang.clear_history}
        danger
      />
    </>
  )
}

export default History