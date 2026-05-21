view: orders_ext {
  extends: [orders]
  measure: refund {
    type: sum
    sql: ${TABLE}.refund_amount ;;
  }
}
