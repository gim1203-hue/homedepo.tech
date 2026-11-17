import { test, expect } from '@playwright/test'
import { products } from '../../src/data/products.js'

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort())
  // Never contact customer services or send mail while exercising the UI.
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const body = url.pathname === '/api/catalog' ? { products } : { products: [], nextStart: null }
    await route.fulfill({ json: body })
  })
  await page.route('**/identitytoolkit.googleapis.com/**', (route) => route.fulfill({ status: 400, json: { error: { message: 'INVALID_LOGIN_CREDENTIALS' } } }))
})

test('storefront routes render without crashes or horizontal overflow', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const path of ['/', '/shop', '/favorites', '/cart', '/checkout', '/login', '/signup', '/reset-password', '/support', '/legal/privacy', '/missing-page']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('main')).toBeVisible()
    await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0)
    await expect(page.locator('main :is(h1,h2):visible').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), path).toBe(true)
  }
  expect(errors).toEqual([])
})

test('product, favorites, persistent cart and checkout preserve prices', async ({ page }) => {
  await page.goto('/shop')
  const card = page.locator('.product-card').filter({ has: page.getByRole('button', { name: 'Quick add', exact: true }) }).first()
  await expect(card).toBeVisible()
  const name = await card.locator('h3').innerText()
  await card.getByRole('button', { name: 'Add to favorites', exact: true }).click()
  await card.getByRole('button', { name: 'Quick add', exact: true }).click()
  await card.locator('h3 a').click()
  await expect(page.locator('main h1')).toContainText(name)
  await page.goto('/favorites')
  await expect(page.locator('.product-card h3')).toContainText(name)
  await page.goto('/cart')
  await expect(page.locator('.cart-item h2')).toContainText(name)
  const before = await page.locator('.order-card .total strong').innerText()
  await page.reload()
  await expect(page.locator('.order-card .total strong')).toHaveText(before)
  await page.getByRole('button', { name: 'Increase quantity', exact: true }).click()
  await expect(page.locator('.quantity span')).toHaveText('2')
  await page.getByRole('link', { name: 'Continue to checkout' }).click()
  await expect(page.locator('.checkout-item b')).toHaveText('2')
  await page.getByRole('button', { name: /Continue securely/ }).click()
  await expect(page.getByRole('alert')).toContainText('Sign in before checkout')
  await page.goto('/cart')
  await page.getByRole('button', { name: 'Clear bag', exact: true }).click()
  await expect(page.getByText('Your bag is feeling light')).toBeVisible()
})

test('malformed saved cart does not crash the app', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shopsphere-cart', '{"invalid":true}'))
  await page.goto('/cart')
  await expect(page.getByText('Your bag is feeling light')).toBeVisible()
})

test('deleted bundled product remains absent after server catalog loads', async ({ page }) => {
  await page.route('**/api/catalog', (route) => route.fulfill({ json: { products: [] } }))
  await page.goto(`/products/${products[0].id}`)
  await expect(page.locator('main')).not.toContainText(products[0].name)
  await expect(page.locator('main :is(h1,h2):visible').first()).toBeVisible()
})

test('account and admin routes require authentication', async ({ page }) => {
  for (const path of ['/account', '/admin']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.locator('input[type="password"]')).toBeVisible()
  }
})
