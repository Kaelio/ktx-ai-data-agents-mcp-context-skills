view: support {
  sql_table_name: support ;;
  dimension: id {
    type: number
    primary_key: yes
    sql: ${TABLE}.id ;;
  }
  dimension: tickets_open {
    type: number
    sql: ${TABLE}.tickets_open ;;
  }
  measure: churn_risk_pct {
    type: average
    sql: CASE WHEN ${tickets_open} > 5 THEN 1.0 ELSE 0.1 * ${tickets_open} END ;;
  }
}
