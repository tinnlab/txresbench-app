/**
 * Core UI Library Entry Point
 *
 * Exports all public API for use as a library
 */

// Main App component
export { default as App } from './App'

// Core utilities and stores
export * from '@txresbench/framework'

// Module system
export { loadModules } from './modules/loader'
export { createModule } from '@txresbench/framework/module'

// API Client
export * from './api-client'

// Re-export types for consumers
export type { AppModule } from '@txresbench/framework/module-system/types'
