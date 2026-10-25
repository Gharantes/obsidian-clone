import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageName, imageTab, nextTab, tabTitle } from './tabs.ts'

test('tab titles', () => {
  assert.equal(tabTitle('Chapter 1/Scene.md'), 'Scene')
  assert.equal(tabTitle('Chapter 1/Chapter 1.md'), 'Chapter 1', 'folder note')
  assert.equal(tabTitle(null), 'New tab')
  assert.equal(tabTitle(imageTab('Map.png')), 'Map.png', 'image')
  assert.equal(imageName(imageTab('Map.png')), 'Map.png')
  assert.equal(imageName('Map.md'), null)
})

test('closing tabs picks the nearest one left open', () => {
  const tabs = ['a', 'b', 'c', 'd']
  assert.equal(nextTab(tabs, 'b', (t) => t === 'b'), 'c', 'right neighbor first')
  assert.equal(nextTab(tabs, 'd', (t) => t === 'd'), 'c', 'then left')
  assert.equal(nextTab(tabs, 'b', (t) => t === 'b' || t === 'c'), 'd')
  assert.equal(nextTab(tabs, 'b', (t) => t !== 'a'), 'a')
  assert.equal(nextTab(tabs, 'b', (t) => t === 'a'), 'b', 'active stays')
  assert.equal(nextTab(tabs, 'b', () => true), null, 'none left')
  assert.equal(nextTab(tabs, null, () => false), null)
})
