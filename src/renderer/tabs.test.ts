import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DETAILS_TAB, imageName, imageTab, nextTab, tabTitle } from './tabs.ts'

test('tab titles', () => {
  assert.equal(tabTitle('Chapter 1/Scene.md'), 'Scene')
  assert.equal(tabTitle('Chapter 1/Chapter 1.md'), 'Chapter 1', 'folder note')
  assert.equal(tabTitle(null), 'New tab')
  assert.equal(tabTitle(imageTab('Map.png')), 'Map.png', 'image')
  assert.equal(tabTitle(imageTab('Naruto/page1.PNG')), 'page1.PNG', 'image in a folder')
  assert.equal(imageName(imageTab('Naruto/page1.PNG')), 'Naruto/page1.PNG')
  assert.equal(imageName('Map.md'), null)
  assert.equal(tabTitle(DETAILS_TAB), 'Details')
  assert.equal(imageName(DETAILS_TAB), null)
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
