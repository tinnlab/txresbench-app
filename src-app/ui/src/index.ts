/**
 * Core UI Library Entry Point
 *
 * Exports all public API for use as a library
 */

// Main App component
export { default as App } from './App'

// Core utilities and stores
export * from '@ziee/framework'

// Module system
export { loadModules } from './modules/loader'
export { createModule } from '@ziee/framework/module'

// Auth guard for protected routes
export { AuthGuard } from './modules/auth'

// API Client
export * from './api-client'

// Re-export types for consumers
export type { AppModule } from '@ziee/framework/module-system/types'
