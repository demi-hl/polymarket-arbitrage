import React from 'react'

export default class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('Dashboard error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[400px] flex items-center justify-center p-8 bg-trader-950">
          <div className="max-w-md text-center space-y-4">
            <h3 className="text-lg font-semibold text-white">Something went wrong</h3>
            <p className="text-sm text-gray-400">
              {this.state.error?.message || 'An error occurred loading this page.'}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 rounded-lg bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors text-sm font-medium"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
